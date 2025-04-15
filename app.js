const fs = require('fs');
const csv = require('csv-parser');
const XLSX = require('xlsx');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

// Arrays to hold our data
let serviceLocations = [];
let leads = [];

// Step 1: Load Service Locations from the Excel File
function loadServiceLocations() {
  // Read the Excel file "All ZIPcodes - Main DB.xlsx"
  const workbook = XLSX.readFile('All ZIPcodes - Main DB.xlsx');
  // Assuming the data is in the first sheet
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  // Convert worksheet to JSON
  serviceLocations = XLSX.utils.sheet_to_json(worksheet);
  console.log(`Loaded ${serviceLocations.length} service locations from Excel.`);
  // Once service locations are loaded, read the leads file.
  readLeads();
}

// Step 2: Load Leads from the CSV File
function readLeads() {
  fs.createReadStream('Leads_2025.csv')
    .pipe(csv())
    .on('data', (row) => {
      leads.push(row);
    })
    .on('end', () => {
      console.log(`Loaded ${leads.length} leads from CSV.`);
      processLeads();
    });
}

// Step 3: Process Each Lead for a Matching Service Location
function processLeads() {
  const processedLeads = leads.map(lead => {
    // Assuming the leads CSV has a column named 'zip'
    let leadZip = lead.zip;
    // First, attempt to find an exact match in serviceLocations
    let directMatch = serviceLocations.find(location => location.zip === leadZip);

    if (directMatch) {
      // Exact match found: add service location info to the lead record
      lead.matched_zip = directMatch.zip;
      lead.locationName = directMatch.locationName || '';
      lead.match_type = 'direct';
    } else {
      // No exact match: find the closest match using numeric proximity.
      let leadZipNum = parseInt(leadZip, 10);
      let closest = null;
      let minDiff = Infinity;

      serviceLocations.forEach(location => {
        let locationZip = location.zip;
        let locationZipNum = parseInt(locationZip, 10);
        let diff = Math.abs(leadZipNum - locationZipNum);
        if (diff < minDiff) {
          minDiff = diff;
          closest = location;
        }
      });

      if (closest) {
        lead.matched_zip = closest.zip;
        lead.locationName = closest.locationName || '';
        lead.match_type = 'closest';
      } else {
        // Fallback in the unlikely event that no match is found.
        lead.matched_zip = '';
        lead.locationName = '';
        lead.match_type = 'none';
      }
    }
    return lead;
  });

  // Step 4: Write the Processed Leads to an Output CSV File
  writeOutput(processedLeads);
}

// Step 4: Write the Processed Data to output.csv
function writeOutput(data) {
  // Define the header for the output CSV.
  // You can add any additional columns from the leads file as needed.
  const csvWriter = createCsvWriter({
    path: 'output.csv',
    header: [
      { id: 'zip', title: 'Lead Zip' },
      // Include other original lead fields here if necessary.
      { id: 'matched_zip', title: 'Matched Service Zip' },
      { id: 'locationName', title: 'Location Name' },
      { id: 'match_type', title: 'Match Type' }
    ]
  });

  csvWriter.writeRecords(data)
    .then(() => {
      console.log('Output written to output.csv');
    })
    .catch(err => {
      console.error('Error writing CSV file:', err);
    });
}

// Start the process by loading service locations from the Excel file.
loadServiceLocations();
