const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const iconsDir = path.join(__dirname, '../public/icons');

// SVG with padding for better icon appearance
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#FF385C" rx="64"/>
  <g transform="translate(96, 80) scale(10)">
    <path fill="white" d="M16 1c2.008 0 3.463.963 4.751 3.269l.533 1.025c1.954 3.83 6.114 12.54 7.1 14.836l.145.353c.667 1.591.91 2.472.96 3.396l.01.415.001.228c0 4.062-2.877 6.478-6.357 6.478-2.224 0-4.556-1.258-6.709-3.386l-.257-.26-.172-.179h-.212l-.257.26c-2.118 2.098-4.413 3.345-6.597 3.386l-.225.002c-3.48 0-6.357-2.416-6.357-6.478 0-1.665.42-3.011 1.116-4.395l.366-.723c.987-2.296 5.147-11.005 7.1-14.836l.533-1.025C12.537 1.963 13.992 1 16 1z"/>
  </g>
</svg>`;

// Icon sizes to generate
const sizes = [
  { name: 'favicon-16x16.png', size: 16 },
  { name: 'favicon-32x32.png', size: 32 },
  { name: 'favicon-48x48.png', size: 48 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'icon-192x192.png', size: 192 },
  { name: 'icon-512x512.png', size: 512 },
];

async function generateIcons() {
  console.log('Generating icons...');

  for (const { name, size } of sizes) {
    const outputPath = path.join(iconsDir, name);

    await sharp(Buffer.from(svgContent))
      .resize(size, size)
      .png()
      .toFile(outputPath);

    console.log(`Created: ${name}`);
  }

  // Generate ICO file (using the 32x32 PNG)
  // For proper ICO, we'll just copy the 32x32 for now
  // A proper ICO would need multiple sizes embedded
  const favicon32 = path.join(iconsDir, 'favicon-32x32.png');
  const faviconIco = path.join(iconsDir, 'favicon.ico');

  // Create a simple favicon.ico from the 32x32 PNG
  // ICO format is complex, so we'll use PNG as favicon which modern browsers support
  fs.copyFileSync(favicon32, path.join(__dirname, '../public/favicon.ico'));
  console.log('Created: favicon.ico (32x32 PNG)');

  console.log('\nAll icons generated successfully!');
  console.log('\nAdd these to your HTML <head>:');
  console.log(`
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">
<link rel="manifest" href="/manifest.json">
  `);
}

generateIcons().catch(console.error);
