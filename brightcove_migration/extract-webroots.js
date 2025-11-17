const fs = require('fs');
const path = require('path');

// Read the CSV file
const csvFile = path.join(__dirname, 'bc-video-all-new.csv');
const csvContent = fs.readFileSync(csvFile, 'utf8');

// Parse CSV and extract unique webroots
const lines = csvContent.split('\n');
const webroots = new Set();

// Skip header line (line 0) and process data lines
for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue; // Skip empty lines
  
  // Parse CSV line (handling quoted values)
  // The webroot is in the 4th column (index 3)
  const columns = line.split(',').map(col => col.replace(/^"|"$/g, '')); // Remove quotes
  
  if (columns.length >= 4) {
    const webroot = columns[3].trim();
    if (webroot && webroot.startsWith('webroot_')) {
      webroots.add(webroot);
    }
  }
}

// Convert Set to sorted array
const uniqueWebroots = Array.from(webroots).sort();

// Output as JavaScript array format
console.log('const CLIENT = [');
uniqueWebroots.forEach((webroot, index) => {
  const comma = index < uniqueWebroots.length - 1 ? ',' : '';
  console.log(`  "${webroot}"${comma}`);
});
console.log('];');

// Also output count
console.log(`\n// Total unique webroots: ${uniqueWebroots.length}`);

