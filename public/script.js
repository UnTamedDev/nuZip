// --- FILE: public/script.js (REVISED for displaying full details) ---

// Existing selectors for bulk processing
const fileInput = document.getElementById('csvFileInput');
const processButton = document.getElementById('processButton');
const statusArea = document.getElementById('statusArea'); // For bulk status
const resultsArea = document.getElementById('resultsArea'); // For bulk download link
const downloadLink = document.getElementById('downloadLink');

// --- Selectors for single lookup ---
const singleLeadNameInput = document.getElementById('singleLeadNameInput');
const singleLeadIdInput = document.getElementById('singleLeadIdInput');
const singleZipInput = document.getElementById('singleZipInput');
const lookupButton = document.getElementById('lookupButton');
const singleResultArea = document.getElementById('singleResultArea');
// --- End Selectors ---

// --- Bulk Processing Logic (Keep as is) ---
if (processButton && fileInput) {
    processButton.addEventListener('click', async () => {
        if (!fileInput.files || fileInput.files.length === 0) {
            updateBulkStatus('Please select a CSV file first.', 'error');
            return;
        }
        const file = fileInput.files[0];
        if (!file.name.toLowerCase().endsWith('.csv')) {
            updateBulkStatus('Invalid file type. Please upload a .csv file.', 'error');
            return;
        }

        const formData = new FormData();
        formData.append('leadsFile', file);

        updateBulkStatus('Uploading and processing file...', 'processing');
        processButton.disabled = true;
        downloadLink.style.display = 'none';
        downloadLink.removeAttribute('href');

        try {
            const response = await fetch('/api/process-csv', { method: 'POST', body: formData });
            const result = await response.json();

            if (!response.ok || !result.success) {
                const errorMessage = result?.error || `Server returned status ${response.status}.`;
                throw new Error(errorMessage);
            }

            updateBulkStatus(`Processing complete! ${result.message || ''}`, 'success');
            if (result.downloadUrl) {
                 downloadLink.href = result.downloadUrl;
                 // Use the original filename base for the download attribute
                 const originalFilenameBase = file.name.replace(/\.[^/.]+$/, ""); // Remove extension
                 downloadLink.setAttribute('download', `${originalFilenameBase}-processed.csv`);
                 downloadLink.style.display = 'inline-block';

            } else {
                 updateBulkStatus(`Processing complete, but no output file generated (perhaps no leads processed?).`, 'success');
            }

        } catch (error) {
            console.error("Bulk Processing error:", error);
            updateBulkStatus(`Error: ${error.message}`, 'error');
            downloadLink.style.display = 'none';
        } finally {
            processButton.disabled = false;
        }
    });
} else {
     console.error("Bulk processing button or file input not found.");
}
// --- End Bulk Processing Logic ---


// --- Single Lookup Logic ---
if (lookupButton && singleLeadNameInput && singleZipInput && singleResultArea) { // Removed singleLeadIdInput from check as it's optional
    lookupButton.addEventListener('click', async () => {
        const leadName = singleLeadNameInput.value.trim();
        const leadId = singleLeadIdInput.value.trim(); // Optional
        const zip = singleZipInput.value.trim();

        // Validation
        if (!zip) {
            displaySingleResult("Please enter a ZIP code.", "error");
            return;
        }
         if (!leadName) {
            displaySingleResult("Please enter the Lead Name.", "error");
            return;
         }
        if (!/^\d{5}$/.test(zip)) { // Strict 5-digit check
            displaySingleResult("Invalid ZIP code format. Please use 5 digits (e.g., 12345).", "error");
            return;
        }

        displaySingleResult("Looking up CNI...", "processing");
        lookupButton.disabled = true;

        try {
            const response = await fetch('/api/lookup-single', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ leadName: leadName, leadId: leadId, zip: zip })
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                const errorMessage = result?.error || `Server lookup failed with status ${response.status}.`;
                throw new Error(errorMessage);
            }

            formatAndDisplaySingleResult(result.match); // Display the detailed results

        } catch (error) {
             console.error("Single lookup error:", error);
             displaySingleResult(`Error: ${error.message}`, "error");
        } finally {
            lookupButton.disabled = false;
        }
    });
} else {
     console.error("Single lookup elements (inputs, button, or result area) not found.");
}
// --- End Single Lookup Logic ---

// --- Helper Functions ---

// Updates status for BULK processing
function updateBulkStatus(message, type = 'info') {
    statusArea.textContent = ''; // Clear previous
    const statusDiv = document.createElement('div');
    statusDiv.textContent = message;
    statusDiv.className = type; // 'processing', 'success', or 'error'
    statusArea.appendChild(statusDiv);
}

// Updates status for SINGLE lookup
function displaySingleResult(message, type = 'info') {
     if (singleResultArea) {
        singleResultArea.innerHTML = `<p class="${type}">${escapeHTML(message)}</p>`;
        singleResultArea.className = `result-box ${type}`; // Add type class for styling
     }
 }

// Formats and displays the SINGLE lookup result with ALL details
function formatAndDisplaySingleResult(match) {
    if (!match) {
        displaySingleResult("No match data received from server.", "error");
        return;
    }

    const leadName = match.leadName || '(Name not provided)';
    const leadZip = match.zip; // Original zip requested

    let html = `<h4>Lookup Result for: ${escapeHTML(leadName)}</h4>`;
    html += `<p style="font-size: 0.9em; color: #666;">Requested ZIP: ${escapeHTML(leadZip)}</p>`;
    html += `<hr style="margin: 10px 0; border: none; border-top: 1px solid #eee;">`;

    html += `<ul>`;
    html += `<li><strong>Match Type:</strong> ${escapeHTML(match.match_type || 'N/A')}</li>`;

    if (match.location_name && match.matched_zip) {
        html += `<li><strong>Matched CNI:</strong> ${escapeHTML(match.location_name)}</li>`;
        html += `<li><strong>Matched ZIP:</strong> ${escapeHTML(match.matched_zip)}</li>`;
        html += `<li><strong>State:</strong> ${escapeHTML(match.state || 'N/A')}</li>`;
        html += `<li><strong>Email:</strong> ${escapeHTML(match.email || 'N/A')}</li>`;
        html += `<li><strong>CNI Status:</strong> ${escapeHTML(match.cni_status || 'N/A')}</li>`;
        html += `<li><strong>Source:</strong> ${escapeHTML(match.source || 'N/A')}</li>`;
        // Optionally display coordinates if needed
        // html += `<li><strong>Coords:</strong> Lat ${match.latitude?.toFixed(4) || 'N/A'}, Lon ${match.longitude?.toFixed(4) || 'N/A'}</li>`;
    } else {
        html += `<li><strong>Matched CNI:</strong> None Found</li>`;
    }

    // Display distance information based on match type
    if (match.match_type === 'direct') {
         html += `<li><strong>Distance:</strong> 0 miles (Direct Match)</li>`;
    } else if (match.match_type !== 'none' && match.match_type !== 'geocode_failed' && match.match_type !== 'invalid_lead_zip' && match.cni_distance_miles !== null) {
         const distanceLabel = match.match_type === 'no_driving_distance' ? 'Straight-Line Distance' : 'Driving Distance';
         const distanceSuffix = match.match_type === 'no_driving_distance' ? ' (Driving route not found)' : '';
         html += `<li><strong>${distanceLabel}:</strong> ~${escapeHTML(match.cni_distance_miles)} miles${distanceSuffix}</li>`;
         // Optionally show text/duration from Google API if available and not straight-line
         if (match.distance_text && match.duration_text && match.match_type !== 'no_driving_distance') {
              html += `<li><strong>Route Details:</strong> ${escapeHTML(match.distance_text)}, ${escapeHTML(match.duration_text)}</li>`;
         }
    }


    html += `</ul>`;

    if (singleResultArea) {
        singleResultArea.innerHTML = html;
        singleResultArea.className = 'result-box success'; // Mark as success
    }
}


// Simple HTML escape helper
function escapeHTML(str) {
     if (str === null || str === undefined) return '';
     const div = document.createElement('div');
     div.textContent = str.toString(); // Ensure it's a string
     return div.innerHTML;
 }

console.log("Client-side script loaded.");