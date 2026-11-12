import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { SpineCli } from '../dist/spine/cli.js';
import { loadProject, pickSkeleton } from '../dist/spine/project.js';
import { addAnimation } from '../dist/spine/write.js';
import { deriveAnimation } from '../dist/spine/derive.js';
import { renderFrames, contactSheet } from '../dist/spine/render.js';

const repo = resolve(import.meta.dirname, '..');
const project = join(repo, 'DFY', 'DFY_SIT_DRAFT.spine');
const work = join(repo, '.lab', 'dfy-sit');
mkdirSync(work, { recursive: true });
if (!existsSync(project)) copyFileSync(join(repo, 'DFY', 'DFY_AI_DRAFT.spine'), project);
const config = loadConfig({ ...process.env, SPINE_VERSION: '4.3.26', SPINE_MCP_WORKDIR: work });
const cli = new SpineCli(config);
const doc = pickSkeleton(await loadProject(config, cli, project), 'DFY').doc;
const fps = 30;
const round = n => Math.round(n * 10000) / 10000;
const time = n => Math.round(n * fps) / fps;

function build(loop) {
  const duration = loop ? 4 : 7;
  const bones = {};
  function channel(bone, kind, rows) {
    (bones[bone] ??= {})[kind] = rows.map(([t, ...v]) => kind === 'translate' || kind === 'scale'
      ? { time: time(t), x: v[0], y: v[1] }
      : { time: time(t), value: v[0] });
  }
  const settle = loop ? [[0,1],[1,1],[2,1],[3,1],[4,1]] : [[0,0],[0.33,0.04],[0.8,0.52],[1.3,1.04],[1.6,1],[3,1],[5,1],[7,1]];
  const fromSetup = (name, dx, dy) => channel(name, 'translate', settle.map(([t,v]) => [t,round(dx*v),round(dy*v)]));
  fromSetup('髋',0,-115);
  // IK targets are in root space; leave rig definitions and skin weights intact.
  for (const [name, dx, dy] of [['腿_L关节1',-85,-25],['腿_L关节2',-125,-17],['腿_R关节1',85,-25],['腿_R关节2',125,-17]]) fromSetup(name,dx,dy);
  for (const [name,angle] of [['上臂_L',10],['下臂_L',15],['手_L',-10],['上臂_R',-10],['下臂_R',-15],['手_R',10],['脚_L',-20],['脚_R',20]]) {
    channel(name,'rotate',settle.map(([t,v])=>[t,round(angle*v)]));
  }
  const start = loop ? 0 : 1.6;
  const bodyRows = loop ? [[0,-3],[1,-3.7],[2,-3],[3,-2.5],[4,-3]] : [[0,0],[0.33,4],[0.8,7],[1.3,-4],[1.6,-3],[3,-3.7],[5,-2.5],[7,-3]];
  channel('胸','rotate',bodyRows);
  channel('胸','translate',loop ? [[0,-5,0],[1,-3,0],[2,-5,0],[3,-6,0],[4,-5,0]] : [[0,0,0],[0.8,-3,0],[1.6,-5,0],[3,-3,0],[5,-6,0],[7,-5,0]]);
  channel('头','rotate',loop ? [[0,-4],[1.1,-5],[2.4,-3],[3.3,-4.5],[4,-4]] : [[0,0],[0.8,-1],[1.6,-4],[3,-5],[4.7,-3],[6,-4.5],[7,-4]]);
  channel('头','translate',loop ? [[0,-7,0],[2,-8,1],[4,-7,0]] : [[0,0,0],[1.6,-7,0],[4,-8,1],[7,-7,0]]);
  for(const name of ['瞳_L','瞳_R']) channel(name,'translate',loop ? [[0,-2,3],[1.5,-2,3],[1.7,-3,5],[3.7,-3,5],[4,-2,3]] : [[0,0,0],[1.6,-2,3],[3.2,-2,3],[3.4,-3,5],[6.6,-3,5],[7,-2,3]]);
  const animation = { bones, slots: { fx_think:{attachment:[{name:null}]},thinkhand:{attachment:[{name:null}]} } };
  // Reuse the artist's paired eyelid/lash deform poses, on whole frames.
  animation.attachments = { default:{} };
  for(const [slot,attachments] of Object.entries(doc.animations.idle.attachments?.default ?? {})) {
    if(!/eyelash|^Eyelid_[lr]2/.test(slot)) continue;
    for(const [attachment,timelines] of Object.entries(attachments)) {
      const src = timelines.deform;
      if(!src?.length)continue;
      const blinkAt = loop ? [2.4] : [2.4,5.6];
      const keys = [{time:0}];
      for(const at of blinkAt) {
        keys.push({time:time(at-0.13)});
        for(const k of src) keys.push({...structuredClone(k),time:time(at+((k.time??0)-2.7)*2)});
        keys.push({time:time(at+0.33)});
      }
      keys.push({time:duration});
      keys.sort((a,b)=>a.time-b.time);
      const unique = [...new Map(keys.map(k=>[k.time,k])).values()];
      (animation.attachments.default[slot]??={})[attachment]={deform:unique};
    }
  }
  return deriveAnimation(animation,[{op:'ease',easing:'easeInOutSine'}],{skeleton:doc});
}

const results=[];
for(const [name,loop] of [['ai_sit_down_daze',false],['ai_sit_daze_loop',true]]) {
  const animation=build(loop);
  writeFileSync(join(work,`${name}.json`),JSON.stringify(animation,null,2));
  const result=await addAnimation(config,cli,{project,skeleton:'DFY',name,animation,apply:true,replace:!!doc.animations[name],editor:'inPlace',loopAnimations:loop?[name]:[],trace:{tool:'make-dfy-sit',detail:'sit transition and seated daydream'}});
  console.log(name,JSON.stringify(result)); results.push(result);
  const render=await renderFrames(config,cli,project,{skeleton:'DFY',animation:name,fps:15,scale:50});
  const sheet=contactSheet(render.frames,{maxFrames:12,columns:4,cell:320});
  writeFileSync(join(work,`${name}-sheet.png`),sheet.png);
  writeFileSync(join(work,`${name}-render.json`),JSON.stringify({dir:render.dir,frames:render.frames,selected:sheet.picked},null,2));
}
writeFileSync(join(work,'write-results.json'),JSON.stringify(results,null,2));
console.log('Project:',project);
