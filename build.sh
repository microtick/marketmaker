#!/bin/sh

thisdir=$(pwd)
echo "PWD=$thisdir"

rm -rf dist-*

ncc build coincap.js -o dist-coincap
cd dist-coincap && pkg index.js -o coincap -t linux

cd $thisdir
ncc build pricer.js -o dist-pricer
cd dist-pricer && pkg index.js -o pricer -t linux

