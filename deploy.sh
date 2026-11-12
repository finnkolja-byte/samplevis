#!/bin/bash
set -e

TARGET_DIR="/var/home/shu/services/samplevis"
echo "Creating SampleVis directories..."
mkdir -p "$TARGET_DIR" "$TARGET_DIR/data" "$TARGET_DIR/data/anime-clips" "$TARGET_DIR/data/presets" "$TARGET_DIR/data/uploads" "$TARGET_DIR/data/exports"

cd "$TARGET_DIR"
echo "Building and starting SampleVis container..."
docker compose build --pull
docker compose up -d --remove-orphans

echo "SampleVis deployed successfully on container port 3450!"
