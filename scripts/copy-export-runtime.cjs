const {readFileSync,writeFileSync,mkdirSync}=require('node:fs');
const {join}=require('node:path');
const root=join(__dirname,'..');
const packageFile=require.resolve('exceljs/package.json');
const directory=require('node:path').dirname(packageFile);
const metadata=JSON.parse(readFileSync(packageFile,'utf8'));
if(metadata.version!=='4.4.0')throw Error('Export runtime differs from pinned ExcelJS version');
mkdirSync(join(root,'build'),{recursive:true});
const license=readFileSync(join(directory,'LICENSE'),'utf8');
writeFileSync(join(root,'build','exceljs.runtime.js'),'/*! ExcelJS '+metadata.version+'; MIT License\n'+license+'\n*/\n'+readFileSync(join(directory,'dist','exceljs.min.js'),'utf8'));

const saxesEntry=require.resolve('saxes');
const saxesVersion=require('saxes/package.json').version;
const xmlVersion=require('xmlchars/package.json').version;
if(saxesVersion!=='5.0.1'||xmlVersion!=='2.2.0')throw Error('Word XML runtime differs from the dependency lock');
const xmlRules={'xmlchars/xml/1.0/ed5':'xml-ed5','xmlchars/xml/1.1/ed2':'xml-ed2','xmlchars/xmlns/1.0/ed3':'xml-ns'};
const xmlLicense=readFileSync(join(require('node:path').dirname(require.resolve('xmlchars/package.json')),'LICENSE'),'utf8');
let saxes=readFileSync(saxesEntry,'utf8');
for(const [source,target] of Object.entries(xmlRules)){
  writeFileSync(join(root,'build',target+'.runtime.js'),'/*! xmlchars MIT license\n'+xmlLicense+'\n*/\n'+readFileSync(require.resolve(source),'utf8'));
  saxes=saxes.replace('"'+source+'"','"./'+target+'.runtime.js"');
}
const saxesLicense=`Copyright Louis-Dominique Dubeau and contributors to saxes

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;
writeFileSync(join(root,'build','saxes.runtime.js'),'/*! saxes '+saxesVersion+' ISC\n'+saxesLicense+'\n*/\n'+saxes);
