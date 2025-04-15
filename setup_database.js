// --- FILE: setup_database.js ---

require('dotenv').config(); // Load environment variables from .env
const sqlite3 = require('sqlite3').verbose(); // Use verbose mode for detailed logs during setup
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const csv = require('csv-parser');
const axios = require('axios');

// --- Configuration ---
const DB_FILE = path.join(__dirname, 'cni_database.db'); // Database file name
const LOCATIONS_EXCEL_FILE = path.join(__dirname, 'All ZIPcodes - Main DB.xlsx');
const CONTACTS_CSV_FILE = path.join(__dirname, 'CNI_Screening.csv'); // ADJUST FILENAME IF NEEDED
const GEOCODE_API_URL_TEMPLATE = 'https://maps.googleapis.com/maps/api/geocode/json?address={ZIPCODE}&key={API_KEY}';
const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const RATE_LIMIT_DELAY_MS = 150; // Delay between geocoding requests (adjust if needed)

// --- Column Name Assumptions (ADJUST IF YOUR FILES ARE DIFFERENT) ---
const CNI_LOCATION_ZIP_COL = 'Zip Code';         // Column name for ZIP in Excel file
const CNI_LOCATION_NAME_COL = 'CNI Zipcodes Name'; // Column name for CNI name in Excel file
const CNI_CONTACT_LOOKUP_COL = 'CNI lookup';// Column name for the key in CNI_Screening.csv
const CNI_CONTACT_EMAIL_COL = 'Email';     // Column name for the email in CNI_Screening.csv
// --- End Configuration ---


if (!API_KEY) {
    console.error("FATAL ERROR: GOOGLE_MAPS_API_KEY not found in .env file.");
    process.exit(1);
}

// Helper function for delays
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Function to geocode a single ZIP code
async function geocodeZip(zip) {
    if (!zip) return null;
    console.log(`  Geocoding ZIP: ${zip}...`);
    const apiUrl = GEOCODE_API_URL_TEMPLATE
        .replace('{ZIPCODE}', encodeURIComponent(zip))
        .replace('{API_KEY}', API_KEY);

    try {
        const response = await axios.get(apiUrl);
        if (response.data && response.data.status === 'OK' && response.data.results.length > 0) {
            const location = response.data.results[0].geometry.location;
            console.log(`    -> Success: Lat=${location.lat}, Lng=${location.lng}`);
            return { lat: location.lat, lng: location.lng };
        } else {
            console.warn(`    -> Failed: Status=${response.data.status} for ZIP ${zip}. Response:`, response.data);
            return null;
        }
    } catch (error) {
        console.error(`    -> Error geocoding ZIP ${zip}:`, error.message);
        if (error.response) {
            console.error("      Response Status:", error.response.status);
            console.error("      Response Data:", error.response.data);
        }
        return null;
    }
}

// Main setup function
async function setupDatabase() {
    console.log(`Starting database setup. Using file: ${DB_FILE}`);

    // Delete existing DB file if it exists to start fresh
    if (fs.existsSync(DB_FILE)) {
        console.log("Existing database file found. Deleting for fresh setup...");
        fs.unlinkSync(DB_FILE);
        console.log("Existing database file deleted.");
    }


    // Connect to SQLite database (creates the file if it doesn't exist)
    const db = new sqlite3.Database(DB_FILE, (err) => {
        if (err) {
            console.error("Error opening database:", err.message);
            return;
        }
        console.log('Connected to the SQLite database.');
    });

    // Use serialize to ensure table creation happens before insertion
    db.serialize(async () => {
        console.log("Creating tables if they don't exist...");
        // Create cni_locations table
        db.run(`
            CREATE TABLE IF NOT EXISTS cni_locations (
                zip TEXT PRIMARY KEY,
                locationName TEXT,
                latitude REAL,
                longitude REAL
            )
        `, (err) => {
            if (err) return console.error("Error creating cni_locations table:", err.message);
            console.log("Table 'cni_locations' created or already exists.");
        });

        // Create cni_contacts table
        db.run(`
            CREATE TABLE IF NOT EXISTS cni_contacts (
                cni_lookup_key TEXT PRIMARY KEY,
                email TEXT
            )
        `, (err) => {
            if (err) return console.error("Error creating cni_contacts table:", err.message);
            console.log("Table 'cni_contacts' created or already exists.");
        });

        // --- Process CNI Locations (Excel) ---
        try {
            console.log(`\nProcessing CNI Locations from: ${LOCATIONS_EXCEL_FILE}...`);
            if (!fs.existsSync(LOCATIONS_EXCEL_FILE)) {
                 throw new Error(`Excel file not found at ${LOCATIONS_EXCEL_FILE}`);
            }
            const workbook = XLSX.readFile(LOCATIONS_EXCEL_FILE);
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            const locationsData = XLSX.utils.sheet_to_json(worksheet);
            console.log(`Found ${locationsData.length} rows in Excel.`);

            // Prepare insert statement
            const stmtLocations = db.prepare(`
                INSERT OR IGNORE INTO cni_locations (zip, locationName, latitude, longitude)
                VALUES (?, ?, ?, ?)
            `); // Use OR IGNORE to skip duplicate ZIPs gracefully

            let processedCount = 0;
            for (const location of locationsData) {
                const zip = location[CNI_LOCATION_ZIP_COL]?.toString().trim();
                const locationName = location[CNI_LOCATION_NAME_COL]?.toString().trim();

                if (!zip) {
                    console.warn("Skipping row due to missing ZIP:", location);
                    continue;
                }

                // Geocode the ZIP
                const coords = await geocodeZip(zip);
                await sleep(RATE_LIMIT_DELAY_MS); // IMPORTANT: Respect rate limits

                // Insert into database
                stmtLocations.run(
                    zip,
                    locationName || null, // Handle potentially missing names
                    coords ? coords.lat : null,
                    coords ? coords.lng : null,
                    (err) => {
                        if (err) console.error(`Error inserting location ZIP ${zip}:`, err.message);
                    }
                );

                processedCount++;
                if (processedCount % 50 === 0) {
                    console.log(`  Processed ${processedCount} of ${locationsData.length} locations...`);
                }
            }

            // Finalize the statement after the loop
            await new Promise((resolve, reject) => {
                 stmtLocations.finalize((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            console.log(`Finished processing ${processedCount} CNI locations.`);

        } catch (error) {
            console.error("\n--- ERROR PROCESSING CNI LOCATIONS ---");
            console.error(error);
            console.error("--------------------------------------");
        }

        // --- Process CNI Contacts (CSV) ---
        try {
             console.log(`\nProcessing CNI Contacts from: ${CONTACTS_CSV_FILE}...`);
             if (!fs.existsSync(CONTACTS_CSV_FILE)) {
                  throw new Error(`CSV file not found at ${CONTACTS_CSV_FILE}`);
             }

             const contactsStream = fs.createReadStream(CONTACTS_CSV_FILE)
                .pipe(csv({
                    mapHeaders: ({ header }) => header.trim() // Trim headers just in case
                }));

             const stmtContacts = db.prepare(`
                INSERT OR REPLACE INTO cni_contacts (cni_lookup_key, email)
                VALUES (?, ?)
             `); // Use OR REPLACE if you want updates for existing keys

            let contactCount = 0;
             contactsStream.on('data', (row) => {
                const lookupKey = row[CNI_CONTACT_LOOKUP_COL];
                const email = row[CNI_CONTACT_EMAIL_COL];

                if (lookupKey && email) { // Basic validation
                    stmtContacts.run(lookupKey.trim(), email.trim(), (err) => {
                       if (err) console.error(`Error inserting contact key ${lookupKey}:`, err.message);
                       else contactCount++;
                    });
                } else {
                    console.warn("Skipping contact row due to missing key or email:", row);
                }
             });

             await new Promise((resolve, reject) => {
                 contactsStream.on('end', () => {
                     stmtContacts.finalize((err) => {
                         if (err) reject(err);
                         else {
                              console.log(`Finished processing ${contactCount} CNI contacts.`);
                              resolve();
                         }
                     });
                 });
                 contactsStream.on('error', (err) => {
                     console.error("Error reading contacts CSV stream:", err);
                     // Attempt to finalize anyway? Maybe not safe.
                     stmtContacts.finalize(); // Finalize even on error?
                     reject(err);
                 });
             });

        } catch (error) {
            console.error("\n--- ERROR PROCESSING CNI CONTACTS ---");
            console.error(error);
            console.error("-------------------------------------");
        } finally {
            // Close the database connection when all done
            db.close((err) => {
                if (err) {
                    return console.error("Error closing database:", err.message);
                }
                console.log('\nDatabase connection closed. Setup complete.');
            });
        }
    }); // End db.serialize
}

// Run the setup
setupDatabase();