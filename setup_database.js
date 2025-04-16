// --- FILE: setup_database.js (REVISED) ---

require('dotenv').config(); // Load environment variables from .env
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const csv = require('csv-parser');
const axios = require('axios');

// --- Configuration ---
const DB_FILE = path.join(__dirname, 'cni_database.db');
const CNI_MASTER_CSV_FILE = path.join(__dirname, 'input_file_0.csv'); // Use the uploaded file name
const GEOCODE_API_URL_TEMPLATE = 'https://maps.googleapis.com/maps/api/geocode/json?address={ZIPCODE}&key={API_KEY}';
const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const RATE_LIMIT_DELAY_MS = 150; // Delay between geocoding requests (adjust if needed)
const INVALID_ZIPS_TO_SKIP = ['0', '00000']; // Zips to ignore

// --- CSV Column Name Assumptions (Match input_file_0.csv) ---
const COL_LOCATION_NAME = 'Location name';
const COL_ZIP_CODE = 'Zip Code';
const COL_STATE = 'State';
const COL_EMAIL = 'Email';
const COL_CNI_STATUS = 'CNI Status';
const COL_SOURCE = 'Source';
// --- End Configuration ---

if (!API_KEY) {
    console.error("FATAL ERROR: GOOGLE_MAPS_API_KEY not found in .env file.");
    process.exit(1);
}

// Helper function for delays
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to format ZIP codes to 5 digits with leading zeros
function formatZipCode(zip) {
    if (zip === null || zip === undefined) return null;
    let zipStr = zip.toString().trim();
    // Handle potential non-numeric input or empty strings after trim
    if (!/^\d+$/.test(zipStr) || zipStr === '') return null;
    // Pad with leading zeros if necessary
    return zipStr.padStart(5, '0');
}


// Function to geocode a single ZIP code
async function geocodeZip(zip) {
    const formattedZip = formatZipCode(zip);
    if (!formattedZip || INVALID_ZIPS_TO_SKIP.includes(formattedZip)) {
        console.warn(`  Skipping geocode for invalid/ignored ZIP: ${zip} (Formatted: ${formattedZip})`);
        return null;
    }
    console.log(`  Geocoding formatted ZIP: ${formattedZip}...`);
    const apiUrl = GEOCODE_API_URL_TEMPLATE
        .replace('{ZIPCODE}', encodeURIComponent(formattedZip)) // Use formatted zip for API
        .replace('{API_KEY}', API_KEY);

    try {
        const response = await axios.get(apiUrl, { timeout: 7000 }); // Increased timeout slightly
        if (response.data && response.data.status === 'OK' && response.data.results.length > 0) {
            const location = response.data.results[0].geometry.location;
            console.log(`    -> Success: Lat=${location.lat}, Lng=${location.lng}`);
            return { lat: location.lat, lng: location.lng };
        } else {
            console.warn(`    -> Geocode Failed: Status=${response.data?.status || 'N/A'} for ZIP ${formattedZip}.`);
            // Log more details for specific error types
            if (response.data?.status === 'ZERO_RESULTS') {
                 console.warn(`       -> ZERO_RESULTS indicates the ZIP might not be valid or geocodable.`);
            } else if (response.data?.error_message) {
                 console.warn(`       -> API Error Message: ${response.data.error_message}`);
            }
            return null;
        }
    } catch (error) {
        console.error(`    -> Error geocoding ZIP ${formattedZip}:`, error.message);
        if (error.response) {
            console.error("      Response Status:", error.response.status);
            console.error("      Response Data:", error.response.data);
        } else if (error.request) {
             console.error("      No response received (timeout or network issue).");
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
        try {
            fs.unlinkSync(DB_FILE);
            console.log("Existing database file deleted.");
        } catch (unlinkErr) {
            console.error(`Error deleting existing database file: ${unlinkErr.message}`);
            console.error("Please close any applications using the database and try again.");
            return; // Stop execution if DB can't be deleted
        }
    }

    // Connect to SQLite database (creates the file)
    const db = new sqlite3.Database(DB_FILE, (err) => {
        if (err) {
            console.error("Error opening database:", err.message);
            return;
        }
        console.log('Connected to the SQLite database.');
    });

    // Use serialize to ensure sequential execution
    db.serialize(async () => {
        try {
            console.log("Dropping old tables if they exist...");
            await new Promise((resolve, reject) => {
                 db.run(`DROP TABLE IF EXISTS cni_locations`, (err) => { if(err) reject(err); else resolve(); });
            });
             await new Promise((resolve, reject) => {
                 db.run(`DROP TABLE IF EXISTS cni_contacts`, (err) => { if(err) reject(err); else resolve(); });
            });
             await new Promise((resolve, reject) => {
                 db.run(`DROP TABLE IF EXISTS cni_data`, (err) => { if(err) reject(err); else resolve(); }); // Drop new table too if re-running
            });
            console.log("Old tables dropped (if they existed).");

            console.log("Creating new 'cni_data' table...");
            await new Promise((resolve, reject) => {
                db.run(`
                    CREATE TABLE IF NOT EXISTS cni_data (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        location_name TEXT NOT NULL,
                        zip TEXT NOT NULL,
                        state TEXT,
                        email TEXT,
                        cni_status TEXT,
                        source TEXT,
                        latitude REAL,
                        longitude REAL,
                        UNIQUE(location_name, zip) -- Ensures unique combination
                    )
                `, (err) => {
                    if (err) { console.error("Error creating cni_data table:", err.message); reject(err); }
                    else { console.log("Table 'cni_data' created successfully."); resolve(); }
                });
            });

            // Add index for faster zip lookups
            await new Promise((resolve, reject) => {
                db.run(`CREATE INDEX IF NOT EXISTS idx_zip ON cni_data (zip)`, (err) => {
                     if (err) { console.warn("Could not create index on zip:", err.message); } // Warn but continue
                     else { console.log("Index on 'zip' column created."); }
                     resolve(); // Resolve regardless of index creation success
                });
            });

            // --- Process CNI Master Data (CSV) ---
            console.log(`\nProcessing CNI Master Data from: ${CNI_MASTER_CSV_FILE}...`);
            if (!fs.existsSync(CNI_MASTER_CSV_FILE)) {
                 throw new Error(`CSV file not found at ${CNI_MASTER_CSV_FILE}`);
            }

            // Use a transaction for potentially faster bulk inserts
            await new Promise((resolve, reject) => db.run('BEGIN TRANSACTION', (err) => err ? reject(err) : resolve()));

            const stmtInsert = db.prepare(`
                INSERT OR IGNORE INTO cni_data
                    (location_name, zip, state, email, cni_status, source, latitude, longitude)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `); // Use OR IGNORE based on UNIQUE constraint

            let rowCount = 0;
            let processedCount = 0;
            let skippedCount = 0;
            let geocodeFailCount = 0;

            const stream = fs.createReadStream(CNI_MASTER_CSV_FILE).pipe(csv({
                 mapHeaders: ({ header }) => header.trim() // Trim headers
            }));

            for await (const row of stream) {
                rowCount++;
                const locationName = row[COL_LOCATION_NAME]?.trim();
                const originalZip = row[COL_ZIP_CODE]; // Keep original for formatting
                const state = row[COL_STATE]?.trim() || null;
                const email = row[COL_EMAIL]?.trim() || null;
                const cniStatus = row[COL_CNI_STATUS]?.trim() || null;
                const source = row[COL_SOURCE]?.trim() || null;

                // Basic validation
                if (!locationName) {
                    console.warn(`Skipping row ${rowCount} due to missing Location Name.`);
                    skippedCount++;
                    continue;
                }

                const formattedZip = formatZipCode(originalZip);
                if (!formattedZip || INVALID_ZIPS_TO_SKIP.includes(formattedZip)) {
                    console.warn(`Skipping row ${rowCount} for CNI '${locationName}' due to invalid/ignored ZIP: '${originalZip}' (Formatted: ${formattedZip})`);
                    skippedCount++;
                    continue;
                }

                // Geocode the valid ZIP
                const coords = await geocodeZip(formattedZip);
                await sleep(RATE_LIMIT_DELAY_MS); // IMPORTANT: Respect rate limits

                if (!coords) {
                    geocodeFailCount++;
                    console.warn(` -> Failed to geocode ZIP ${formattedZip} for CNI '${locationName}'. Inserting without coordinates.`);
                }

                // Insert into database
                await new Promise((resolve, reject) => {
                    stmtInsert.run(
                        locationName,
                        formattedZip,
                        state,
                        email,
                        cniStatus,
                        source,
                        coords ? coords.lat : null,
                        coords ? coords.lng : null,
                        function(err) { // Use function() to access this.changes
                            if (err) {
                                console.error(`Error inserting row ${rowCount} (Zip ${formattedZip}, Name ${locationName}):`, err.message);
                                // Optionally reject(err) here if one error should stop everything, but IGNORE should handle most issues.
                            } else {
                                // this.changes tells if a row was actually inserted (1) or ignored (0)
                                if (this.changes > 0) {
                                    processedCount++;
                                } else {
                                    // Log if ignored, might indicate unexpected duplicate pairs if UNIQUE constraint was hit
                                    // console.warn(`  Row ${rowCount} (Zip ${formattedZip}, Name ${locationName}) ignored, likely duplicate.`);
                                }
                            }
                             resolve(); // Resolve whether inserted or ignored
                        }
                    );
                });


                if (rowCount % 100 === 0) {
                    console.log(`  Checked ${rowCount} rows from CSV. Inserted/Processed: ${processedCount}, Skipped Invalid: ${skippedCount}, Geocode Fails: ${geocodeFailCount}...`);
                }
            } // End for await loop

            // Finalize the statement and commit transaction
             await new Promise((resolve, reject) => stmtInsert.finalize(err => err ? reject(err) : resolve()));
             await new Promise((resolve, reject) => db.run('COMMIT', (err) => err ? reject(err) : resolve()));

            console.log(`\n--- CNI Master Data Processing Summary ---`);
            console.log(`Total rows read from CSV: ${rowCount}`);
            console.log(`Rows successfully processed & inserted (or ignored as duplicate): ${processedCount}`);
            console.log(`Rows skipped due to invalid ZIP/missing name: ${skippedCount}`);
            console.log(`Geocoding failures (inserted without coords): ${geocodeFailCount}`);
            console.log(`------------------------------------------`);

        } catch (error) {
            console.error("\n--- FATAL ERROR DURING DATABASE SETUP ---");
            console.error(error);
            console.error("----------------------------------------");
            // Attempt to rollback transaction on error
             await new Promise((resolve) => db.run('ROLLBACK', () => resolve())); // Ignore rollback error
        } finally {
            // Close the database connection
            db.close((err) => {
                if (err) {
                    return console.error("Error closing database:", err.message);
                }
                console.log('\nDatabase connection closed. Setup process finished.');
            });
        }
    }); // End db.serialize
}

// Run the setup
setupDatabase();