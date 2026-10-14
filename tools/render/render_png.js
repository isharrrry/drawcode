const fs = require('fs');
const { Resvg } = require('@resvg/resvg-js');

const [, , inFile, outFile, widthArg] = process.argv;
const svg = fs.readFileSync(inFile);
const width = widthArg ? parseInt(widthArg, 10) : 0;

const resvg = new Resvg(svg, {
  fitTo: width ? { mode: 'width', value: width } : { mode: 'original' },
  background: '#ffffff',
  font: {
    loadSystemFonts: true,
    defaultFontFamily: 'Arial',
  },
});

const png = resvg.render().asPng();
fs.writeFileSync(outFile, png);
console.log(`${outFile} ${png.length} bytes ${resvg.width}x${resvg.height}`);
