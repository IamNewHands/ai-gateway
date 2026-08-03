import fs from 'fs'

// Load the esbuild output and evaluate the module to get renderAdminPage
const code = fs.readFileSync('dist/_test.js', 'utf8')

// Mock Cloudflare Workers globals
globalThis.crypto = { randomUUID: () => 'mock-uuid' }
globalThis.Request = class Request {
  constructor(url, init) { this.url = url; this.headers = new Map(Object.entries(init?.headers || {})) }
}
globalThis.Response = class Response {
  constructor(body, init) {
    this._body = body
    this.status = init?.status || 200
    this.headers = new Map(Object.entries(init?.headers || {}))
  }
  async json() { return JSON.parse(this._body) }
  async text() { return this._body }
}

// Execute the module
try {
  const module = { exports: {} }
  // Wrap in a way that captures the default export
  const fn = new Function('module', 'exports', 'require', code + '\nreturn module.exports')
  // Actually the esbuild output uses ESM... let's just search for the HTML content
  console.log('Code length:', code.length)
  
  // Search for renderAdminPage in the code
  const idx = code.indexOf('renderAdminPage')
  if (idx >= 0) {
    console.log('renderAdminPage found at', idx)
    console.log('Context:', code.substring(idx, idx + 200))
  }
} catch (e) {
  console.log('Error:', e.message)
}
