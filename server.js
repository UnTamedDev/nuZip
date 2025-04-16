// --- FILE: server.js (REVISED for new DB schema and full output) ---

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
const MAX_DISTANCE_MATRIX_DESTINATIONS = 25; // Google API limit per request
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
    // Connect in READWRITE mode if we need to write, READONLY otherwise.
    // Sticking with READONLY for now as server only reads.
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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(PROCESSED_DIR));

// --- Haversine Formula ---
function calculateStraightLineDistance(lat1, lon1, lat2, lon2) {
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return Infinity;
    const R = 3958.8; // Radius of the Earth in miles
    const toRad = (deg) => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    lat1 = toRad(lat1); lat2 = toRad(lat2);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1) * Math.cos(lat2) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}


// --- Database & API Helper Functions ---

// Geocode Lead ZIP
async function geocodeZip(zip) {
    if (!zip || !API_KEY) return null;
    // Basic 5-digit zip validation before hitting API
    if (!/^\d{5}$/.test(zip)) {
         console.warn(`  Invalid lead ZIP format for geocoding: ${zip}`);
         return null;
    }
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

// Find direct match using the new 'cni_data' table, return full row
function findDirectCNI(zipCode) {
     return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("Database not connected"));
        if (!zipCode) return resolve(null); // Handle null/empty zip
        const formattedZip = zipCode.toString().trim().padStart(5, '0'); // Ensure 5 digits
        // Select all columns needed for the final output
        const sql = `
            SELECT
                id, location_name, zip, state, email, cni_status, source, latitude, longitude
            FROM cni_data
            WHERE zip = ?
            LIMIT 1`;
        db.get(sql, [formattedZip], (err, row) => {
            if (err) {
                console.error(`Error querying cni_data for ZIP ${formattedZip}:`, err.message);
                resolve(null); // Resolve null on error to allow proximity search
            } else {
                resolve(row); // Resolve with the full row object or undefined if not found
            }
        });
    });
}

// Fetch CNI details by primary key (id) - useful after proximity match
function getCNIDetailsById(id) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("Database not connected"));
        if (id === null || id === undefined) return resolve(null);
        // Select all columns needed for the final output
        const sql = `
            SELECT
               id, location_name, zip, state, email, cni_status, source, latitude, longitude
            FROM cni_data
            WHERE id = ?
            LIMIT 1`;
        db.get(sql, [id], (err, row) => {
            if (err) {
                console.error(`Error querying cni_data for ID ${id}:`, err.message);
                reject(err); // Reject on error here as we expect the ID to be valid
            } else {
                resolve(row); // Resolve with the full row object or undefined
            }
        });
    });
}


// Get CNIs for proximity search (only fields needed for calculation)
function getAllCNIsForProximitySearch() {
    console.log(">>> Fetching CNI data for proximity search...");
    return new Promise((resolve, reject) => {
        if (!db) {
             console.error(">>> ERROR in getAllCNIsForProximitySearch: Database not connected");
             return reject(new Error("Database not connected"));
        }
        // Select only needed fields + the ID to fetch full details later
        const sql = `SELECT id, location_name, zip, latitude, longitude FROM cni_data WHERE latitude IS NOT NULL AND longitude IS NOT NULL`;
        console.log(">>> Executing SQL:", sql);

        db.all(sql, [], (err, rows) => {
            if (err) {
                console.error(">>> ERROR fetching CNI data for proximity:", err.message);
                reject(err);
            } else {
                const rowCount = rows ? rows.length : 0;
                console.log(`>>> Successfully fetched ${rowCount} CNI records with coordinates.`);
                resolve(rows || []); // Ensure an array is always returned
            }
        });
    });
}

// Get driving distances (input/output includes the CNI 'id')
async function getDrivingDistances(originCoords, destinationCNIs) {
    if (!originCoords || !destinationCNIs || destinationCNIs.length === 0 || !API_KEY) { return []; }
    const resultsWithDistance = [];
    console.log(`  Calculating driving distances for up to ${destinationCNIs.length} CNIs...`);

    for (let i = 0; i < destinationCNIs.length; i += MAX_DISTANCE_MATRIX_DESTINATIONS) {
        const batch = destinationCNIs.slice(i, i + MAX_DISTANCE_MATRIX_DESTINATIONS);
        const destinationsString = batch.map(dest => `${dest.latitude},${dest.longitude}`).join('|');
        const apiUrl = DISTANCE_API_URL_TEMPLATE
            .replace('{ORIGIN_LAT}', originCoords.lat)
            .replace('{ORIGIN_LNG}', originCoords.lng)
            .replace('{DESTINATIONS}', encodeURIComponent(destinationsString))
            .replace('{API_KEY}', API_KEY);

        console.log(`    Batch ${Math.floor(i / MAX_DISTANCE_MATRIX_DESTINATIONS) + 1}: Requesting Distance Matrix for ${batch.length} destinations...`);
        try {
            const response = await axios.get(apiUrl, { timeout: 10000 }); // Slightly longer timeout for matrix
            if (response.data?.status === 'OK' && response.data.rows?.[0]?.elements) {
                const elements = response.data.rows[0].elements;
                elements.forEach((element, index) => {
                    const correspondingCNI = batch[index]; // Keep original CNI data (id, name, zip, coords)
                    if (!correspondingCNI) {
                         console.warn(`    -> Warning: Index mismatch in distance matrix response batch.`);
                         return;
                    }
                    if (element.status === 'OK' && element.distance?.value !== undefined) { // Check for distance value presence
                        resultsWithDistance.push({
                            ...correspondingCNI, // Include id, name, zip, lat, lon
                            distanceMeters: element.distance.value, // Store numeric distance in meters
                            distanceMiles: element.distance.value / METERS_PER_MILE, // Calculate miles
                            distanceText: element.distance.text,
                            durationText: element.duration.text
                        });
                    } else {
                        console.warn(`    -> Distance element status not OK for CNI ID ${correspondingCNI?.id} (ZIP ${correspondingCNI?.zip}): ${element.status}`);
                         // Optionally add with Infinity distance if needed for sorting logic later
                         resultsWithDistance.push({
                             ...correspondingCNI,
                             distanceMeters: Infinity,
                             distanceMiles: Infinity,
                             distanceText: 'N/A',
                             durationText: 'N/A'
                         });
                    }
                });
            } else { console.error(`    -> Distance Matrix API Error: Status=${response.data?.status}`, response.data?.error_message || ''); }
        } catch (error) { console.error(`    -> Distance Matrix HTTP Error:`, error.message); }
    } // End batch loop

    // Sort by numeric distance (meters or miles)
    resultsWithDistance.sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity));
    console.log(`  Finished distance calculations. Found ${resultsWithDistance.filter(r => r.distanceMiles !== Infinity).length} valid driving routes.`);
    return resultsWithDistance;
}


// --- Core Matching Logic ---
// Returns an object with full CNI details or nulls/defaults
async function performSingleMatch(leadData, allCNIsForProximity) {
    const { leadZip } = leadData;
    // Define the default structure for the response object
    const defaultResult = {
        matched_cni_id: null, // Store the ID of the matched row in cni_data
        location_name: null,
        matched_zip: null,
        state: null,
        email: null,
        cni_status: null,
        source: null,
        latitude: null,
        longitude: null,
        match_type: 'none',
        cni_distance_miles: null,
        distance_text: null,
        duration_text: null
    };

    console.log(`Performing match for Lead ZIP: ${leadZip}`);

    // --- Validate Lead ZIP ---
    const formattedLeadZip = leadZip?.toString().trim().padStart(5, '0');
    if (!formattedLeadZip || !/^\d{5}$/.test(formattedLeadZip)) {
        console.warn(`  Invalid lead ZIP provided: ${leadZip}`);
        return { ...defaultResult, match_type: 'invalid_lead_zip' };
    }

    // --- 1. Try Direct CNI Match ---
    const directMatch = await findDirectCNI(formattedLeadZip);
    if (directMatch) {
        console.log(`  Direct match found: CNI ID ${directMatch.id} - ${directMatch.location_name} (${directMatch.zip})`);
        // Return all details from the matched row
        return {
            matched_cni_id: directMatch.id,
            location_name: directMatch.location_name,
            matched_zip: directMatch.zip,
            state: directMatch.state,
            email: directMatch.email,
            cni_status: directMatch.cni_status,
            source: directMatch.source,
            latitude: directMatch.latitude,
            longitude: directMatch.longitude,
            match_type: 'direct',
            cni_distance_miles: 0,
            distance_text: '0 mi', // Direct match distance
            duration_text: 'N/A'
        };
    }

    // --- 2. Proximity Search ---
    console.log(`  No direct match for ${formattedLeadZip}. Performing proximity search...`);
    if (!allCNIsForProximity || allCNIsForProximity.length === 0) {
         console.warn("  Cannot perform proximity search: No CNI locations available.");
         return { ...defaultResult, match_type: 'no_cni_data' }; // Indicate no data was available
    }

    const leadCoords = await geocodeZip(formattedLeadZip);
    if (!leadCoords) {
        console.warn(`  Geocode failed for lead ZIP ${formattedLeadZip}. Cannot perform proximity search.`);
        return { ...defaultResult, match_type: 'geocode_failed' };
    }

    // Filter by ZIP Prefix
    const leadZipPrefix = formattedLeadZip.substring(0, ZIP_PREFIX_LENGTH);
    const prefixFilteredCNIs = allCNIsForProximity.filter(cni =>
        cni.zip?.startsWith(leadZipPrefix) && cni.latitude !== null && cni.longitude !== null
    );
    console.log(`  Filtered by ZIP prefix '${leadZipPrefix}': ${prefixFilteredCNIs.length} potential CNIs.`);
    if (prefixFilteredCNIs.length === 0) {
        return { ...defaultResult, match_type: 'no_prefix_match' };
    }

    // Filter by Straight-Line Distance
    const nearbyCNIs = prefixFilteredCNIs.filter(cni =>
        calculateStraightLineDistance(leadCoords.lat, leadCoords.lng, cni.latitude, cni.longitude) <= STRAIGHT_LINE_THRESHOLD_MILES
    );
    console.log(`  Filtered by Haversine (${STRAIGHT_LINE_THRESHOLD_MILES} mi): ${nearbyCNIs.length} nearby CNIs.`);
     if (nearbyCNIs.length === 0) {
        return { ...defaultResult, match_type: 'no_nearby_cnis' };
    }

    // Sort remaining by straight-line distance initially (important fallback)
    nearbyCNIs.sort((a, b) =>
        calculateStraightLineDistance(leadCoords.lat, leadCoords.lng, a.latitude, a.longitude) -
        calculateStraightLineDistance(leadCoords.lat, leadCoords.lng, b.latitude, b.longitude)
    );

    // Calculate Driving Distances
    const cnisWithDistances = await getDrivingDistances(leadCoords, nearbyCNIs);

    if (cnisWithDistances.length > 0 && cnisWithDistances[0].distanceMiles !== Infinity) {
        const closestCNI = cnisWithDistances[0]; // Has id, location_name, zip, coords, distanceMiles etc.
        console.log(`  -> Closest driving match: CNI ID ${closestCNI.id} - ${closestCNI.location_name} (${closestCNI.zip}) at ${closestCNI.distanceMiles.toFixed(1)} miles.`);

        // Fetch the *full* details for the matched CNI using its ID
        const fullMatchDetails = await getCNIDetailsById(closestCNI.id);
        if (!fullMatchDetails) {
             console.error(`  -> CRITICAL: Failed to retrieve full details for matched CNI ID ${closestCNI.id}. Returning partial data.`);
             // Fallback to data we already have from the distance calculation
             return {
                 ...defaultResult, // Start with defaults
                 matched_cni_id: closestCNI.id,
                 location_name: closestCNI.location_name,
                 matched_zip: closestCNI.zip,
                 latitude: closestCNI.latitude,
                 longitude: closestCNI.longitude,
                 match_type: closestCNI.distanceMiles <= MILES_THRESHOLD ? 'within_15_miles' : 'closest_driving',
                 cni_distance_miles: closestCNI.distanceMiles.toFixed(1),
                 distance_text: closestCNI.distanceText,
                 duration_text: closestCNI.durationText
                 // Other fields (state, email etc.) will be null here
             };
        }

        // Return full details from the database + distance info
        return {
            matched_cni_id: fullMatchDetails.id,
            location_name: fullMatchDetails.location_name,
            matched_zip: fullMatchDetails.zip,
            state: fullMatchDetails.state,
            email: fullMatchDetails.email,
            cni_status: fullMatchDetails.cni_status,
            source: fullMatchDetails.source,
            latitude: fullMatchDetails.latitude,
            longitude: fullMatchDetails.longitude,
            match_type: closestCNI.distanceMiles <= MILES_THRESHOLD ? 'within_15_miles' : 'closest_driving',
            cni_distance_miles: closestCNI.distanceMiles.toFixed(1),
            distance_text: closestCNI.distanceText,
            duration_text: closestCNI.durationText
        };

    } else {
        // No driving distances found, use closest straight-line CNI as fallback
        console.warn(`  -> Driving distance check yielded no valid routes. Falling back to closest straight-line.`);
        const closestStraightLine = nearbyCNIs[0]; // Already sorted
        const straightLineDistance = calculateStraightLineDistance(leadCoords.lat, leadCoords.lng, closestStraightLine.latitude, closestStraightLine.longitude);
        console.log(`     -> Assigning closest straight-line CNI: ID ${closestStraightLine.id} - ${closestStraightLine.location_name} (${closestStraightLine.zip}) at ~${straightLineDistance.toFixed(1)} miles`);

        // Fetch full details for this CNI
        const fullMatchDetails = await getCNIDetailsById(closestStraightLine.id);
        if (!fullMatchDetails) {
            console.error(`  -> CRITICAL: Failed to retrieve full details for straight-line fallback CNI ID ${closestStraightLine.id}. Returning partial data.`);
            // Fallback to data we have
             return {
                 ...defaultResult,
                 matched_cni_id: closestStraightLine.id,
                 location_name: closestStraightLine.location_name,
                 matched_zip: closestStraightLine.zip,
                 latitude: closestStraightLine.latitude,
                 longitude: closestStraightLine.longitude,
                 match_type: 'no_driving_distance',
                 cni_distance_miles: straightLineDistance.toFixed(1),
                 distance_text: `~${straightLineDistance.toFixed(1)} mi (straight)`,
                 duration_text: 'N/A'
             };
        }

        // Return full details + straight-line distance
        return {
            matched_cni_id: fullMatchDetails.id,
            location_name: fullMatchDetails.location_name,
            matched_zip: fullMatchDetails.zip,
            state: fullMatchDetails.state,
            email: fullMatchDetails.email,
            cni_status: fullMatchDetails.cni_status,
            source: fullMatchDetails.source,
            latitude: fullMatchDetails.latitude,
            longitude: fullMatchDetails.longitude,
            match_type: 'no_driving_distance', // Indicate driving failed
            cni_distance_miles: straightLineDistance.toFixed(1),
            distance_text: `~${straightLineDistance.toFixed(1)} mi (straight)`,
            duration_text: 'N/A'
        };
    }
}


// --- API Endpoint for CSV Processing ---
app.post('/api/process-csv', upload.single('leadsFile'), async (req, res) => {
    console.log("Received file upload request...");
    if (!req.file) { return res.status(400).json({ success: false, error: 'No CSV file was uploaded.' }); }

    const inputFilePath = req.file.path;
    const originalFilenameBase = path.basename(req.file.originalname, path.extname(req.file.originalname));
    const outputFilename = `${originalFilenameBase}-processed-${Date.now()}.csv`;
    const outputFilePath = path.join(PROCESSED_DIR, outputFilename);
    console.log(`Input file: ${inputFilePath}`);
    console.log(`Output file: ${outputFilePath}`);

    let allCNIsForProximity = null;
    try {
        const leads = await readCSV(inputFilePath);
        if (!Array.isArray(leads)) { throw new Error("Failed to parse the uploaded CSV file correctly."); }
        console.log(`Read ${leads.length} leads from uploaded file.`);
        if (leads.length === 0) { throw new Error("Uploaded CSV file is empty or contains no valid data rows."); }

        // Determine the ZIP code header dynamically
        let zipHeader = null;
        const potentialZipHeaders = ['Zip Code', 'zip', 'Zip']; // Add others if needed
        const firstLeadHeaders = Object.keys(leads[0] || {});
        for (const header of potentialZipHeaders) {
            if (firstLeadHeaders.includes(header)) {
                zipHeader = header;
                console.log(`Using header "${zipHeader}" for lead ZIP codes.`);
                break;
            }
        }
        if (!zipHeader) {
            throw new Error(`Could not find a valid ZIP code header in the CSV (tried: ${potentialZipHeaders.join(', ')}). Found headers: ${firstLeadHeaders.join(', ')}`);
        }

        // Fetch CNI data needed for proximity checks *once*
        allCNIsForProximity = await getAllCNIsForProximitySearch();
        if (!Array.isArray(allCNIsForProximity)) { throw new Error("Failed to fetch CNI locations from the database."); }
        console.log(`Fetched ${allCNIsForProximity.length} CNI locations with coordinates for matching.`);

        console.log("Processing leads (CSV)...");
        const processedLeads = [];
        let processCounter = 0;

        for (const lead of leads) {
             processCounter++;
             const leadDataForMatch = { leadZip: lead[zipHeader] }; // Use the dynamically found header

             console.log(`\nProcessing Lead #${processCounter} (Input ZIP: ${leadDataForMatch.leadZip})...`);
             const matchResult = await performSingleMatch(leadDataForMatch, allCNIsForProximity);

             // Combine original lead data with the full match result
             // Ensure original lead fields don't clash with result fields (e.g., if lead had 'state')
             // Prefix match results to avoid clashes if necessary, or carefully select fields.
             // Here, we'll overwrite original fields like 'state', 'email' if they existed in the lead
             // with the matched CNI's data.
             const outputRow = {
                 ...lead, // Start with original lead data
                 cni_location_name: matchResult.location_name,
                 cni_matched_zip: matchResult.matched_zip,
                 cni_state: matchResult.state,
                 cni_email: matchResult.email,
                 cni_status: matchResult.cni_status,
                 cni_source: matchResult.source,
                 cni_latitude: matchResult.latitude,
                 cni_longitude: matchResult.longitude,
                 cni_match_type: matchResult.match_type,
                 cni_distance_miles: matchResult.cni_distance_miles,
                 cni_distance_text: matchResult.distance_text,
                 cni_duration_text: matchResult.duration_text,
                 matched_cni_db_id: matchResult.matched_cni_id // Optional: include the DB id for reference
             };
             processedLeads.push(outputRow);

             if (processCounter % 50 === 0) {
                 console.log(` Processed ${processCounter} of ${leads.length} leads...`);
             }
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
        // Ensure the uploaded file is deleted even if processing fails
        if (inputFilePath && fs.existsSync(inputFilePath)) {
            fs.unlink(inputFilePath, (err) => {
                if (err) console.error(`Error deleting uploaded file ${inputFilePath}:`, err);
                else console.log(`Deleted uploaded file: ${inputFilePath}`);
            });
        }
    }
});


// --- API Endpoint for Single Lookup ---
app.post('/api/lookup-single', async (req, res) => {
    console.log("Received single lookup request:", req.body);
    const { zip, leadName, leadId } = req.body;
    if (!zip) { return res.status(400).json({ success: false, error: 'ZIP code is required for lookup.' }); }
    if (!/^\d{5}$/.test(zip)) { // Basic 5-digit validation
         return res.status(400).json({ success: false, error: 'Invalid ZIP code format (must be 5 digits).' });
    }

    let allCNIsForProximity = null;
    try {
         const leadData = { leadZip: zip };
         console.log(`[Single Lookup] Performing match for ZIP: ${zip}`);

         // Fetch CNI data needed for proximity checks *only if* direct match fails
         allCNIsForProximity = await getAllCNIsForProximitySearch();
         if (!Array.isArray(allCNIsForProximity)) {
             console.error("[Single Lookup] ERROR: getAllCNIsForProximitySearch did not return an array.");
             throw new Error("Database query for CNI locations failed.");
         }
         console.log(`[Single Lookup] Fetched ${allCNIsForProximity.length} CNI locations with coords for potential proximity search.`);

         // Perform the match (handles both direct and proximity)
         const matchResult = await performSingleMatch(leadData, allCNIsForProximity);

         console.log("[Single Lookup] Match complete.");
         // Return the full match result object, plus the original lead info for context
         return res.json({
             success: true,
             match: {
                 leadName: leadName || '',
                 leadId: leadId || '',
                 zip: zip, // Original requested ZIP
                 ...matchResult // Include all fields from matchResult
            }
         });

    } catch (error) {
        console.error("[Single Lookup] Error:", error);
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
      .pipe(csv()) // csv-parser handles header detection automatically
      .on('data', (data) => results.push(data))
      .on('end', () => { console.log(`CSV file reading finished. Found ${results.length} rows.`); resolve(results); })
      .on('error', (error) => { console.error(`Error reading CSV stream for ${filePath}:`, error); reject(error); });
  });
}

async function writeCSV(filePath, data) {
  if (!data || data.length === 0) {
      console.log("No data provided to writeCSV function.");
      return Promise.resolve(); // Return a resolved promise if no data
  }
  // Dynamically create headers from the keys of the first data object
  const headers = Object.keys(data[0]).map(key => ({ id: key, title: key }));
  console.log("Writing CSV Headers:", headers.map(h => h.title).join(', '));

  const csvWriterInstance = createObjectCsvWriter({
      path: filePath,
      header: headers,
      alwaysQuote: true // Ensure fields with commas, etc., are quoted
  });

  try {
      await csvWriterInstance.writeRecords(data);
      console.log(`CSV successfully written to ${filePath}`);
  } catch (error) {
      console.error(`Error writing CSV to ${filePath}:`, error);
      throw error; // Re-throw the error to be caught by the calling function
  }
}


// --- Start Server & Shutdown ---
const server = app.listen(PORT, () => { console.log(`CNI Matcher server running on http://localhost:${PORT}`); });

process.on('SIGINT', () => {
    console.log('Received SIGINT. Closing server and database connection...');
    server.close(() => {
         console.log('HTTP server closed.');
         if (db) {
            db.close((err) => {
                if (err) { console.error('Error closing database:', err.message); }
                else { console.log('Database connection closed.'); }
                process.exit(0);
            });
         } else { process.exit(0); }
    });
});