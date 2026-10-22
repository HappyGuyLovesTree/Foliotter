'use strict';
// Optional authoring dependency: sharp. Runtime needs neither Node nor sharp.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
async function main(){
  const sharp=require(process.env.REDBOOK_SHARP || 'sharp');
  const root=path.resolve(__dirname,'..'),source=path.join(root,'packaging/redbook.svg');
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'redbook-icon-'));
  const iconset=path.join(temporary,'RedBook.iconset');
  try {
    await fs.mkdir(iconset);
    for(const size of [16,32,128,256,512])for(const scale of [1,2]){
      const name=`icon_${size}x${size}${scale===2?'@2x':''}.png`;
      await sharp(source).resize(size*scale,size*scale).png().toFile(path.join(iconset,name));
    }
    await sharp(source).resize(512,512).png().toFile(path.join(root,'packaging/redbook.png'));
    execFileSync('/usr/bin/iconutil',['-c','icns',iconset,'-o',path.join(root,'packaging/RedBook.icns')]);
  } finally {await fs.rm(temporary,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
