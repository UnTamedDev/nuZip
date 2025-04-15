// --- FILE: public/script.js (MODIFIED for Single Lookup) ---

// Existing selectors for bulk processing
const fileInput = document.getElementById('csvFileInput');
const processButton = document.getElementById('processButton');
const statusArea = document.getElementById('statusArea'); // For bulk status
const resultsArea = document.getElementById('resultsArea'); // For bulk download link
const downloadLink = document.getElementById('downloadLink');

// --- NEW: Selectors for single lookup ---
const singleLeadNameInput = document.getElementById('singleLeadNameInput'); // NEW
const singleLeadIdInput = document.getElementById('singleLeadIdInput');   // NEW
const singleZipInput = document.getElementById('singleZipInput');
// const singleCniLookupInput = document.getElementById('singleCniLookupInput'); // REMOVED
const lookupButton = document.getElementById('lookupButton');
const singleResultArea = document.getElementById('singleResultArea');
// --- End NEW Selectors ---


// Event Listener for Bulk Processing Button
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
                 downloadLink.style.display = 'inline-block';
                 downloadLink.setAttribute('download', file.name.replace('.csv', '-processed.csv'));
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


if (lookupButton && singleLeadNameInput && singleLeadIdInput && singleZipInput && singleResultArea) {
    lookupButton.addEventListener('click', async () => {
        const leadName = singleLeadNameInput.value.trim(); // Get Lead Name
        const leadId = singleLeadIdInput.value.trim();     // Get Lead ID
        const zip = singleZipInput.value.trim();           // Get ZIP

        // --- Basic Validation ---
        if (!zip) {
            displaySingleResult("Please enter a ZIP code.", "error");
            return;
        }
         if (!leadName) { // Require name for context
            displaySingleResult("Please enter the Lead Name.", "error");
            return;
         }
        if (!/^\d{5}(-\d{4})?$/.test(zip)) {
            displaySingleResult("Invalid ZIP code format. Please use 5 digits (e.g., 12345).", "error");
            return;
        }
        // --- End Validation ---


        displaySingleResult("Looking up CNI...", "processing");
        lookupButton.disabled = true;

        try {
            const response = await fetch('/api/lookup-single', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // --- UPDATED: Send name, id, zip ---
                body: JSON.stringify({
                    leadName: leadName,
                    leadId: leadId, // Send optional ID
                    zip: zip
                 })
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                const errorMessage = result?.error || `Server lookup failed with status ${response.status}.`;
                throw new Error(errorMessage);
            }

            // Display formatted results (function updated below)
            formatAndDisplaySingleResult(result.match);

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
// --- End Single Lookup Listener ---

// --- Helper Functions ---

// Update status for BULK processing
// updateBulkStatus (Keep as is)
function updateBulkStatus(message, type = 'info') { /* ... */ }

// displaySingleResult (Keep as is)
function displaySingleResult(message, type = 'info') { /* ... */ }

// formatAndDisplaySingleResult (MODIFIED to include Lead Name/ID)
function formatAndDisplaySingleResult(match) {
    if (!match) {
        displaySingleResult("No match data received from server.", "error");
        return;
    }

    // Use info passed back from server for context
    const leadName = match.leadName || '(Name not provided)';
    const leadId = match.leadId || '(ID not provided)';
    const leadZip = match.zip; // Original zip requested

    let html = `<h4>Lookup Result for: ${escapeHTML(leadName)}</h4>`;
    // Optional: Display Lead ID if needed
    // html += `<p style="font-size: 0.9em; color: #666;">Lead ID: ${escapeHTML(leadId)}</p>`;
    html += `<p style="font-size: 0.9em; color: #666;">Requested ZIP: ${escapeHTML(leadZip)}</p>`;
    html += `<hr style="margin: 10px 0; border: none; border-top: 1px solid #eee;">`; // Separator

    html += `<ul>`;
    html += `<li><strong>Match Type:</strong> ${escapeHTML(match.match_type || 'N/A')}</li>`;

    if (match.matched_zip) {
        html += `<li><strong>Matched CNI:</strong> ${escapeHTML(match.locationName)} (${escapeHTML(match.matched_zip)})</li>`;
    } else {
        html += `<li><strong>Matched CNI:</strong> None Found</li>`;
    }

    if (match.match_type !== 'direct' && match.cni_distance_miles) {
         html += `<li><strong>Driving Distance:</strong> ~${escapeHTML(match.cni_distance_miles)} miles</li>`; // Added ~ indicator
    } else if (match.match_type === 'direct') {
         html += `<li><strong>Distance:</strong> 0 miles (Direct Match)</li>`;
    } else if (match.match_type === 'no_driving_distance' && match.cni_distance_miles) {
        html += `<li><strong>Straight-Line Distance:</strong> ~${escapeHTML(match.cni_distance_miles)} miles (Driving route not found)</li>`;
    }

    // Email lookup was removed from core match logic for now
    // html += `<li><strong>Contact Email:</strong> ${escapeHTML(match.cni_email || 'Not Found')}</li>`;

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
     div.textContent = str;
     return div.innerHTML;
 }

console.log("Client-side script loaded.");