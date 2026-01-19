# UNIDOWN

Download property photos and descriptions from Airbnb listings.

## Features

- **Fast API-based scraping** - Direct HTTP requests, no browser automation
- **High-quality images** - Downloads full resolution photos (2-3MB each)
- **Save properties** - Keep a list of URLs for quick access
- **Simple web UI** - Easy to use interface at `http://localhost:30002`
- **Tor support** - Optional Tor integration for IP rotation

## What Gets Downloaded

| Data | Status |
|------|--------|
| Title | ✅ |
| Description | ✅ |
| Images (5 high-res) | ✅ |
| Rating | ✅ |

## Installation

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/UNIDOWN.git
cd UNIDOWN

# Install dependencies
npm install

# Start the server
npm start
```

Open http://localhost:30002 in your browser.

## Usage

1. Paste an Airbnb listing URL (e.g., `https://www.airbnb.com/rooms/8492758`)
2. Add a name for the property
3. Click **Download**
4. View results in the "Scraped Results" section

## Downloaded Files

Files are saved to the `downloads/` folder:

```
downloads/[room_id]/
├── images/
│   ├── image_1.png
│   ├── image_2.png
│   └── ...
├── description.txt
└── metadata.json
```

## Optional: Tor Support

For IP rotation, install Tor:

```bash
brew install tor
brew services start tor
```

Then enable Tor in the web UI.

## Tech Stack

- Node.js + Express
- Direct HTTP requests (no Puppeteer/browser)
- Airbnb's embedded JSON data extraction

## Disclaimer

This tool is for personal use only. Respect Airbnb's terms of service and rate limits.
