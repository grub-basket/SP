// Generates Alpha.stash + Beta.stash — canonical reset snapshots for the
// Claude Dev Vault test folders. Importable via the plugin's "Import .stash"
// (or dropped into a folder's import subfolder). Dependency-free zip writer.
import { writeFileSync } from "fs";
const enc = new TextEncoder();
const CRC = (() => { const t=new Uint32Array(256); for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c>>>0;} return t; })();
const crc32=b=>{let c=0xFFFFFFFF;for(let i=0;i<b.length;i++)c=CRC[(c^b[i])&0xff]^(c>>>8);return (c^0xFFFFFFFF)>>>0;};
function zip(files){const u16=v=>[v&0xff,(v>>>8)&0xff],u32=v=>[v&0xff,(v>>>8)&0xff,(v>>>16)&0xff,(v>>>24)&0xff];const ch=[],cen=[];let off=0;
for(const f of files){const nb=enc.encode(f.name),d=f.data,crc=crc32(d),s=d.length;
ch.push(new Uint8Array([0x50,0x4b,3,4,...u16(20),...u16(0),...u16(0),...u16(0),...u16(0x21),...u32(crc),...u32(s),...u32(s),...u16(nb.length),...u16(0)]),nb,d);
cen.push(new Uint8Array([0x50,0x4b,1,2,...u16(20),...u16(20),...u16(0),...u16(0),...u16(0),...u16(0x21),...u32(crc),...u32(s),...u32(s),...u16(nb.length),...u16(0),...u16(0),...u16(0),...u16(0),...u32(0),...u32(off)]),nb);
off+=30+nb.length+s;}
const cdStart=off;let cdSize=0;for(const c of cen){ch.push(c);cdSize+=c.length;}
ch.push(new Uint8Array([0x50,0x4b,5,6,...u16(0),...u16(0),...u16(files.length),...u16(files.length),...u32(cdSize),...u32(cdStart),...u16(0)]));
const tot=ch.reduce((a,c)=>a+c.length,0),out=new Uint8Array(tot);let p=0;for(const c of ch){out.set(c,p);p+=c.length;}return out;}
function note(id,parent,created,body){return `---\nid: ${id}\nparent: ${parent}\ncreated: ${created}\nattachments: []\n---\n${body}`;}
function buildFolderStash(F){
  const pfx=F.toLowerCase();
  const defs=[
    ["note-1",`${pfx}n1`,"__root__","2026-06-08T12:01:00",`Top-level note 1 in ${F}.`],
    ["note-2",`${pfx}n2`,"__root__","2026-06-08T12:02:00",`Top-level note 2 in ${F}.`],
    ["note-3",`${pfx}n3`,"__root__","2026-06-08T12:03:00",`Top-level note 3 in ${F}.`],
    ["note-4",`${pfx}n4`,"__root__","2026-06-08T12:04:00",`Top-level note 4 in ${F}.`],
    ["note-5",`${pfx}n5`,"__root__","2026-06-08T12:05:00",`Top-level note 5 in ${F}.`],
    ["child-a",`${pfx}c1`,`${pfx}n1`,"2026-06-08T12:06:00",`Child A under note 1 of ${F}.`],
    ["child-b",`${pfx}c2`,`${pfx}n1`,"2026-06-08T12:07:00",`Child B under note 1 of ${F}.`],
    ["grand",`${pfx}g1`,`${pfx}c1`,"2026-06-08T12:08:00",`Grandchild under child A of ${F}.`],
  ];
  const files=defs.map(([file,id,parent,created,body])=>({name:`notes/${file}-${id}.md`,data:enc.encode(note(id,parent,created,body))}));
  const manifest={stashSchema:1,exportedAt:"2026-06-08T12:00:00.000Z",sourceFolder:F,noteCount:defs.length,rootIds:[`${pfx}n1`,`${pfx}n2`,`${pfx}n3`,`${pfx}n4`,`${pfx}n5`],generator:"reset-snapshot"};
  files.push({name:"manifest.json",data:enc.encode(JSON.stringify(manifest,null,2))});
  return zip(files);
}
for (const F of ["Alpha","Beta"]) { const bytes=buildFolderStash(F); writeFileSync(new URL(`./${F}.stash`,import.meta.url), Buffer.from(bytes)); console.log(`wrote ${F}.stash (${bytes.length} bytes)`); }
