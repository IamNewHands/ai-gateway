import fs from 'fs'
const c = fs.readFileSync('dist/_test.js', 'utf8')
// Find the HTML content section - search for script tag content
const scriptMatch = c.match(/<script>([\s\S]*?)<\/script>/)
if (!scriptMatch) { console.log('No script tag found'); process.exit(0) }
const js = scriptMatch[1]
// Check for unterminated single-quote strings
const lines = js.split('\n')
for (let i = 0; i < lines.length; i++) {
  const l = lines[i]
  let inStr = false, esc = false
  for (let j = 0; j < l.length; j++) {
    const ch = l[j]
    if (esc) { esc = false; continue }
    if (ch === '\\') { esc = true; continue }
    if (ch === "'" && !inStr) { inStr = true }
    else if (ch === "'" && inStr) { inStr = false }
  }
  if (inStr) {
    console.log(`Line ${i + 1} has unterminated single-quote: ${l.substring(0, 150)}`)
  }
}
console.log('Check complete')
