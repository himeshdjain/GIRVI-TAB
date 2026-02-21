// ... after your middleware and before your routes ...

// 1. Serve static files (this lets the browser find styles.css and api-client.js)
app.use(express.static(path.join(__dirname, './')));

// 2. Define the Root Route (this fixes the "Route not found: GET /" error)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ... then your existing API routes ...