// --- FILE: server.js (With Debugging Logs Restored) ---

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const { createObjectCsvWriter } = require('csv-writer');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Configuration ---
const MILES_THRESHOLD = 15;
const STRAIGHT_LINE_THRESHOLD_MILES = 30;
const ZIP_PREFIX_LENGTH = 1; // How many digits to match for initial filter
const METERS_PER_MILE = 1609.34;
const MAX_DISTANCE_MATRIX_DESTINATIONS = 25;
const GEOCODE_API_URL_TEMPLATE = 'https://maps.googleapis.com/maps/api/geocode/json?address={ZIPCODE}&key={API_KEY}';
const DISTANCE_API_URL_TEMPLATE = 'https://maps.googleapis.com/maps/api/distancematrix/json?origins={ORIGIN_LAT},{ORIGIN_LNG}&destinations={DESTINATIONS}&key={API_KEY}&units=imperial';
const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
// --- End Configuration ---

// --- Database Setup & Connection ---
const DB_FILE = path.join(__dirname, 'cni_database.db');
let db;
function connectDatabase() {
    if (!fs.existsSync(DB_FILE)) {
        console.error(`FATAL ERROR: Database file not found at ${DB_FILE}. Please run setup_database.js first.`);
        process.exit(1);
    }
    db = new sqlite3.Database(DB_FILE, sqlite3.OPEN_READONLY, (err) => {
        if (err) {
            console.error(`Error connecting to database: ${err.message}`);
            process.exit(1);
        }
        console.log('Successfully connected to the CNI SQLite database (read-only).');
    });
}
connectDatabase();

// --- Multer Configuration ---
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, UPLOAD_DIR); },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// --- Output Directory ---
const PROCESSED_DIR = path.join(__dirname, 'processed');
fs.mkdirSync(PROCESSED_DIR, { recursive: true });

// --- Middleware ---
app.use(express.json()); // Ensure JSON body parsing is enabled
app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(PROCESSED_DIR));

// --- Haversine Formula ---
function calculateStraightLineDistance(lat1, lon1, lat2, lon2) {
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return Infinity; // Handle null coords
    const R = 3958.8; // Radius of the Earth in miles
    const toRad = (deg) => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    lat1 = toRad(lat1); // Convert source lat to radians once
    lat2 = toRad(lat2); // Convert dest lat to radians once
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1) * Math.cos(lat2) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in miles
}


// --- Database & API Helper Functions ---
async function geocodeZip(zip) {
    if (!zip || !API_KEY) return null;
    console.log(`  Geocoding Lead ZIP: ${zip}...`);
    const apiUrl = GEOCODE_API_URL_TEMPLATE.replace('{ZIPCODE}', encodeURIComponent(zip)).replace('{API_KEY}', API_KEY);
    try {
        const response = await axios.get(apiUrl, { timeout: 5000 });
        if (response.data?.status === 'OK' && response.data.results.length > 0) {
            const location = response.data.results[0].geometry.location;
            console.log(`    -> Lead Geocode Success: Lat=${location.lat}, Lng=${location.lng}`);
            return location;
        } else {
            console.warn(`    -> Lead Geocode Failed: Status=${response.data?.status} for ZIP ${zip}.`);
            return null;
        }
    } catch (error) {
        console.error(`    -> Lead Geocode Error for ZIP ${zip}:`, error.message);
        return null;
    }
 }
function findDirectCNILocation(zipCode) {
     return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("Database not connected"));
        if (!zipCode) return resolve(null);
        const sql = `SELECT zip, locationName, latitude, longitude FROM cni_locations WHERE zip = ? LIMIT 1`;
        db.get(sql, [zipCode.toString().trim()], (err, row) => {
            if (err) { console.error(`Error querying cni_locations for ZIP ${zipCode}:`, err.message); resolve(null); }
            else { resolve(row); }
        });
    });
}
// Removed findCNIEmail for now

// --- >>> ADD DEBUG LOGS BACK <<< ---
function getAllCNILocationsWithCoords() {
    console.log(">>> Entering getAllCNILocationsWithCoords"); // Log Entry
    return new Promise((resolve, reject) => {
        if (!db) {
             console.error(">>> ERROR in getAllCNILocationsWithCoords: Database not connected");
             return reject(new Error("Database not connected"));
        }

        const sql = `SELECT zip, locationName, latitude, longitude FROM cni_locations WHERE latitude IS NOT NULL AND longitude IS NOT NULL`;
        console.log(">>> Executing SQL:", sql); // Log SQL

        db.all(sql, [], (err, rows) => {
            if (err) {
                console.error(">>> ERROR fetching all CNI locations:", err.message); // Log Error
                reject(err); // Reject on error
            } else {
                // Check if rows is undefined or null before accessing length
                const rowCount = rows ? rows.length : 'null/undefined';
                console.log(`>>> Successfully fetched ${rowCount} rows.`); // Log Success
                resolve(rows || []); // Resolve with the rows (or empty array if null/undefined)
            }
        });
    });
}
// --- >>> END DEBUG LOGS <<< ---

async function getDrivingDistances(originCoords, destinationCNIs) {
    if (!originCoords || !destinationCNIs || destinationCNIs.length === 0 || !API_KEY) { return []; }
    const resultsWithDistance = [];
    for (let i = 0; i < destinationCNIs.length; i += MAX_DISTANCE_MATRIX_DESTINATIONS) {
        const batch = destinationCNIs.slice(i, i + MAX_DISTANCE_MATRIX_DESTINATIONS);
        const destinationsString = batch.map(dest => `${dest.latitude},${dest.longitude}`).join('|');
        const apiUrl = DISTANCE_API_URL_TEMPLATE
            .replace('{ORIGIN_LAT}', originCoords.lat)
            .replace('{ORIGIN_LNG}', originCoords.lng)
            .replace('{DESTINATIONS}', encodeURIComponent(destinationsString))
            .replace('{API_KEY}', API_KEY);
        console.log(`  Requesting Distance Matrix for ${batch.length} destinations...`);
        try {
            const response = await axios.get(apiUrl, { timeout: 10000 });
            if (response.data?.status === 'OK' && response.data.rows?.[0]?.elements) {
                const elements = response.data.rows[0].elements;
                elements.forEach((element, index) => {
                    const correspondingCNI = batch[index];
                    if (element.status === 'OK' && element.distance) {
                        // Added replace(/,/,'') for distances > 999 miles
                        resultsWithDistance.push({
                            ...correspondingCNI,
                            distanceMiles: parseFloat(element.distance.text.replace(/ mi/,'').replace(/,/,'')),
                            distanceText: element.distance.text,
                            durationText: element.duration.text
                        });
                    } else { console.warn(`    -> Distance element status not OK for CNI ZIP ${correspondingCNI?.zip}: ${element.status}`); }
                });
            } else { console.error(`  -> Distance Matrix API Error: Status=${response.data?.status}`, response.data?.error_message || ''); }
        } catch (error) { console.error(`  -> Distance Matrix HTTP Error:`, error.message); }
    }
    resultsWithDistance.sort((a, b) => (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity));
    return resultsWithDistance;
}


// --- Reusable Core Matching Logic (Email Lookup Removed) ---
async function performSingleMatch(leadData, allCNILocations) {
    const { leadZip } = leadData;
    let matchResult = {
        matched_zip: null, locationName: null, match_type: 'none',
        cni_distance_miles: null, cni_lat: null,
        cni_lon: null, distanceText: null, durationText: null
    };
    console.log(`Performing match for ZIP: ${leadZip}`);

    // 1. Try Direct CNI Location Match
    if (leadZip) {
        const directMatchLocation = await findDirectCNILocation(leadZip);
        if (directMatchLocation) {
             matchResult.matched_zip = directMatchLocation.zip;
             matchResult.locationName = directMatchLocation.locationName;
             matchResult.match_type = 'direct';
             matchResult.cni_distance_miles = 0;
             matchResult.cni_lat = directMatchLocation.latitude;
             matchResult.cni_lon = directMatchLocation.longitude;
             console.log(`  Direct match found: ${matchResult.matched_zip} - ${matchResult.locationName}`);
        } else {
            // 2. Proximity Search
            if (allCNILocations && allCNILocations.length > 0) {
                console.log(`  No direct match for ${leadZip}. Performing proximity search...`);
                const leadCoords = await geocodeZip(leadZip);
                if (leadCoords) {
                    const leadZipPrefix = leadZip.substring(0, ZIP_PREFIX_LENGTH);
                    const prefixFilteredCNIs = allCNILocations.filter(cni => cni.zip?.startsWith(leadZipPrefix) && cni.latitude !== null && cni.longitude !== null);
                    console.log(`  Filtered by ZIP prefix '${leadZipPrefix}': ${prefixFilteredCNIs.length} potential CNIs.`);

                    if (prefixFilteredCNIs.length > 0) {
                        const nearbyCNIs = prefixFilteredCNIs.filter(cni => calculateStraightLineDistance(leadCoords.lat, leadCoords.lng, cni.latitude, cni.longitude) <= STRAIGHT_LINE_THRESHOLD_MILES);
                        console.log(`  Filtered by Haversine (${STRAIGHT_LINE_THRESHOLD_MILES} mi): ${nearbyCNIs.length} nearby CNIs.`);

                        if (nearbyCNIs.length > 0) {
                            nearbyCNIs.sort((a, b) => calculateStraightLineDistance(leadCoords.lat, leadCoords.lng, a.latitude, a.longitude) - calculateStraightLineDistance(leadCoords.lat, leadCoords.lng, b.latitude, b.longitude));
                            const cnisWithDistances = await getDrivingDistances(leadCoords, nearbyCNIs);

                            if (Array.isArray(cnisWithDistances) && cnisWithDistances.length > 0) {
                                const closestCNI = cnisWithDistances[0];
                                matchResult.matched_zip = closestCNI.zip;
                                matchResult.locationName = closestCNI.locationName;
                                matchResult.cni_distance_miles = closestCNI.distanceMiles;
                                matchResult.match_type = closestCNI.distanceMiles <= MILES_THRESHOLD ? 'within_15_miles' : 'closest_driving';
                                matchResult.cni_lat = closestCNI.latitude;
                                matchResult.cni_lon = closestCNI.longitude;
                                matchResult.distanceText = closestCNI.distanceText;
                                matchResult.durationText = closestCNI.durationText;
                                console.log(`  -> Closest driving match: ${closestCNI.zip} at ${closestCNI.distanceMiles.toFixed(1)} miles.`);
                            } else {
                                console.warn(`  -> Driving distance check yielded no results.`);
                                const closestStraightLine = nearbyCNIs[0];
                                matchResult.matched_zip = closestStraightLine.zip;
                                matchResult.locationName = closestStraightLine.locationName;
                                matchResult.match_type = 'no_driving_distance';
                                matchResult.cni_distance_miles = calculateStraightLineDistance(leadCoords.lat, leadCoords.lng, closestStraightLine.latitude, closestStraightLine.longitude);
                                console.log(`     -> Assigning closest straight-line CNI: ${closestStraightLine.zip} at ~${matchResult.cni_distance_miles.toFixed(1)} miles`);
                            }
                        } else { matchResult.match_type = 'no_nearby_cnis'; }
                    } else { matchResult.match_type = 'no_prefix_match'; }
                } else { matchResult.match_type = 'geocode_failed'; }
            } else { console.log(`  Skipping proximity search for ${leadZip} as no CNI locations with coords were available.`); }
        }
    } else { matchResult.match_type = 'missing_zip'; }

    return {
        matched_zip: matchResult.matched_zip || '',
        locationName: matchResult.locationName || '',
        match_type: matchResult.match_type,
        cni_distance_miles: matchResult.cni_distance_miles !== null ? matchResult.cni_distance_miles.toFixed(1) : ''
        // Removed cni_email from return
    };
}


// --- API Endpoint for CSV Processing ---
app.post('/api/process-csv', upload.single('leadsFile'), async (req, res) => {
    console.log("Received file upload request...");
    if (!req.file) { return res.status(400).json({ success: false, error: 'No CSV file was uploaded.' }); }

    const inputFilePath = req.file.path;
    const outputFilename = `processed-leads-${Date.now()}.csv`;
    const outputFilePath = path.join(PROCESSED_DIR, outputFilename);
    console.log(`Input file: ${inputFilePath}`);
    console.log(`Output file: ${outputFilePath}`);

    let allCNILocationsWithCoords = null;
    try {
        const leads = await readCSV(inputFilePath);
        if (!Array.isArray(leads)) { throw new Error("Failed to parse the uploaded CSV file correctly."); }
        console.log(`Read ${leads.length} leads from uploaded file.`);
        if (leads.length === 0) { throw new Error("Uploaded CSV file is empty or contains no valid data rows."); }

        allCNILocationsWithCoords = await getAllCNILocationsWithCoords();
        if (!Array.isArray(allCNILocationsWithCoords)) { throw new Error("Failed to fetch CNI locations from the database."); }
        console.log(`Fetched ${allCNILocationsWithCoords.length} CNI locations with coordinates for matching.`);
        if (allCNILocationsWithCoords.length === 0) { console.warn("No CNI locations with coordinates found in database. Proximity search will not be performed."); }

        console.log("Processing leads (CSV)...");
        const processedLeads = [];

        for (const lead of leads) {
             const leadDataForMatch = {
                 leadZip: lead['Zip Code'] || lead['zip'] || lead['Zip'],
                 // cniLookupKey: lead['CNI lookup'] || lead['CNI Reference'] || lead['CNILookup'] // Keep this if needed for bulk email lookup
             };
             const matchResult = await performSingleMatch(leadDataForMatch, allCNILocationsWithCoords);

             // Find email separately IF needed for bulk output, using the original lead data
             let cni_email = '';
             const cniLookupKey = lead['CNI lookup'] || lead['CNI Reference'] || lead['CNILookup'];
             if (cniLookupKey) {
                 // Need to implement findCNIEmail if you want email in bulk output
                 // For now, leave it blank in bulk, as it was removed from performSingleMatch
                 // cni_email = await findCNIEmail(cniLookupKey) || '';
             }

             processedLeads.push({
                 ...lead,
                 ...matchResult,
                 cni_email: cni_email // Add email back if lookup implemented
             });
        }

        console.log("Finished processing all leads.");

        if (processedLeads.length === 0 && leads.length > 0) { throw new Error("Failed to process any leads successfully."); }
        else if (processedLeads.length === 0) { return res.json({ success: true, message: `No leads found or processed.`, downloadUrl: null }); }
        else {
            await writeCSV(outputFilePath, processedLeads);
            console.log(`Successfully wrote processed data to ${outputFilePath}`);
            res.json({
                success: true,
                message: `Successfully processed ${processedLeads.length} leads.`,
                downloadUrl: `/downloads/${outputFilename}`
            });
        }

    } catch (error) {
        console.error(`Error processing file ${inputFilePath}:`, error);
        res.status(500).json({ success: false, error: `Failed to process CSV file: ${error.message}` });
    } finally {
        fs.unlink(inputFilePath, (err) => { if (err) console.error(`Error deleting uploaded file ${inputFilePath}:`, err); else console.log(`Deleted uploaded file: ${inputFilePath}`); });
    }
});

// --- API Endpoint for Single Lookup ---
app.post('/api/lookup-single', async (req, res) => {
    console.log("Received single lookup request:", req.body);
    const { zip, leadName, leadId } = req.body; // Expect zip, leadName, leadId
    if (!zip) { return res.status(400).json({ success: false, error: 'ZIP code is required for lookup.' }); }
    if (!/^\d{5}(-\d{4})?$/.test(zip)) { return res.status(400).json({ success: false, error: 'Invalid ZIP code format.' }); }

    let allCNILocations = null;
    try {
         const leadData = { leadZip: zip };
         console.log(`[Single Lookup] Checking direct match for ZIP: ${zip}`);
         const directMatch = await findDirectCNILocation(zip);

         if (directMatch) {
             console.log("[Single Lookup] Direct match found.");
             const matchResult = await performSingleMatch(leadData, null); // Pass null for locations
             return res.json({ success: true, match: { leadName: leadName || '', leadId: leadId || '', zip: zip, ...matchResult } });
         } else {
             console.log("[Single Lookup] No direct match, fetching all locations for proximity...");
             try {
                allCNILocations = await getAllCNILocationsWithCoords(); // Call function with logging
                if (!Array.isArray(allCNILocations)) {
                    console.error("[Single Lookup] ERROR: getAllCNILocations returned non-array after await:", allCNILocations);
                    throw new Error("Database query for CNI locations failed.");
                 }
                 console.log(`[Single Lookup] Fetched ${allCNILocations.length} CNI locations with coords.`);
             } catch (dbError) {
                 console.error("[Single Lookup] Database error caught fetching all locations:", dbError);
                 throw new Error("Failed to fetch CNI locations from database for proximity check.");
             }

             const matchResult = await performSingleMatch(leadData, allCNILocations);
             console.log("[Single Lookup] Proximity search complete.");
             return res.json({ success: true, match: { leadName: leadName || '', leadId: leadId || '', zip: zip, ...matchResult } });
         }
    } catch (error) {
        console.error("[Single Lookup] Outer Error Handler:", error);
        const message = error.message.includes("database") || error.message.includes("query") ? "Database error during lookup." : `Single lookup failed: ${error.message}`;
        res.status(500).json({ success: false, error: message });
    }
});


// --- Base Route ---
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// --- Helper Functions ---
function readCSV(filePath) {
  console.log(`Attempting to read CSV: ${filePath}`);
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => { console.log(`CSV file reading finished. Found ${results.length} rows.`); resolve(results); })
      .on('error', (error) => { console.error(`Error reading CSV stream for ${filePath}:`, error); reject(error); });
  });
}
async function writeCSV(filePath, data) {
  if (!data || data.length === 0) { console.log("No data provided to writeCSV function."); return; }
  const headers = Object.keys(data[0]).map(key => ({ id: key, title: key }));
  console.log("CSV Headers:", headers.map(h => h.title));
  const csvWriterInstance = createObjectCsvWriter({ path: filePath, header: headers, alwaysQuote: true });
  return csvWriterInstance.writeRecords(data);
}

// --- Start Server & Shutdown ---
app.listen(PORT, () => { console.log(`ZIP Code Matcher server running on http://localhost:${PORT}`); });
process.on('SIGINT', () => {
    console.log('Received SIGINT. Closing database connection...');
    if (db) { db.close((err) => { if (err) { console.error(err.message); } console.log('Database connection closed.'); process.exit(0); }); }
    else { process.exit(0); }
});