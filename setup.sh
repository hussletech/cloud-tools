#!/bin/bash

echo "==================================="
echo "Brightcove Migration Setup Script"
echo "==================================="
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Node.js not found. Installing..."
    curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
    sudo yum install -y nodejs
else
    echo "✓ Node.js found: $(node --version)"
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "✗ npm not found. Please install Node.js first."
    exit 1
else
    echo "✓ npm found: $(npm --version)"
fi

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "✗ Failed to install dependencies"
    exit 1
fi
echo "✓ Dependencies installed"

# Check for .env file
if [ ! -f .env ]; then
    echo ""
    echo "⚠️  .env file not found. Creating template..."
    cat > .env << 'EOF'
API_KEY=your_brightcove_client_id_here
API_SECRET=your_brightcove_client_secret_here
EOF
    chmod 600 .env
    echo "✓ .env template created. Please edit it with your credentials:"
    echo "  nano .env"
    echo ""
    echo "After editing .env, run: node app.js"
else
    echo "✓ .env file found"
fi

# Check output directory
OUTPUT_DIR="/home/ec2-user/assets.soundconcepts.com"
if [ -d "$OUTPUT_DIR" ]; then
    echo "✓ Output directory found: $OUTPUT_DIR"
else
    echo "⚠️  Output directory not found: $OUTPUT_DIR"
    echo "   Make sure S3 is mounted to this location"
fi

# Check if CSV file exists
if [ -f bc-video-amare-test.csv ]; then
    echo "✓ CSV file found"
else
    echo "⚠️  CSV file not found: bc-video-amare-test.csv"
fi

echo ""
echo "==================================="
echo "Setup Complete!"
echo "==================================="
echo ""
echo "Next steps:"
echo "1. Edit .env file with your Brightcove credentials: nano .env"
echo "2. Update CSV file with your video list: nano bc-video-amare-test.csv"
echo "3. Run the application: node app.js"
echo ""
echo "For production use:"
echo "  npm install -g pm2"
echo "  pm2 start app.js --name bc-migration"
echo "  pm2 logs bc-migration"
echo ""

