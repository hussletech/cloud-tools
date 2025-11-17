#!/bin/bash

# Script to convert videos from beforeProcessing to afterProcessing folder
# Converts to H.264 Baseline Profile Level 3.1 for mobile compatibility

SOURCE_DIR="beforeprocessing"
OUTPUT_DIR="afterprocessing"

# Create output directory if it doesn't exist
mkdir -p "$OUTPUT_DIR"

# Check if source directory exists
if [ ! -d "$SOURCE_DIR" ]; then
    echo "Error: $SOURCE_DIR directory not found!"
    exit 1
fi

# Check if ffmpeg is installed
if ! command -v ffmpeg &> /dev/null; then
    echo "Error: ffmpeg is not installed. Please install it first."
    exit 1
fi

# Process all video files in the source directory
for video in "$SOURCE_DIR"/*.{mp4,MP4,mov,MOV,avi,AVI,mkv,MKV}; do
    # Check if file exists (handles case when no files match the pattern)
    if [ ! -f "$video" ]; then
        continue
    fi
    
    # Get the filename without path
    filename=$(basename "$video")
    output_path="$OUTPUT_DIR/$filename"
    
    echo "Processing: $filename"
    echo "Output: $output_path"
    
    # Convert video to H.264 Baseline Profile Level 3.1
    # -c:v libx264: Use H.264 codec
    # -profile:v baseline: Use Baseline Profile (most compatible)
    # -level 3.1: Set level to 3.1
    # -pix_fmt yuv420p: Ensure compatible pixel format
    # -c:a aac: Keep AAC audio
    # -b:a 128k: Set audio bitrate
    # -movflags +faststart: Move metadata to beginning for web streaming
    ffmpeg -i "$video" \
        -c:v libx264 \
        -profile:v baseline \
        -level 3.1 \
        -pix_fmt yuv420p \
        -c:a aac \
        -b:a 128k \
        -movflags +faststart \
        -y \
        "$output_path" 2>&1 | grep -E "frame=|error|Error" || true
    
    if [ $? -eq 0 ]; then
        echo "✓ Successfully converted: $filename"
        echo ""
    else
        echo "✗ Failed to convert: $filename"
        echo ""
    fi
done

echo "Conversion complete!"
echo "Processed videos are in: $OUTPUT_DIR"


