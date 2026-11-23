import * as T from 'three';
import {lightInterior,finishSurfaces,setInteriorQuality} from './interior.js';
import {prefillPlace} from './portal.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
T.Mesh.prototype.raycast=acceleratedRaycast;
const $=id=>document.getElementById(id);
const places=[['Атриум','atrium','Центральный холл'],['Стеклянная галерея','gallery','Панорамный проход'],['Информационный центр','centre','Учебное пространство']];
for(const [i,[name,img,desc]] of places.entries()){
  const b=document.createElement('button');b.className='card';
  b.innerHTML='<img alt="" src="'+img+'.webp"><span><strong>'+name+'</strong><small>'+desc+'</small></span><span class="chev" aria-hidden="true">ТОЧКА 0'+(i+1)+'</span>';
  b.onclick=()=>start(name);$('cards').append(b);
}
let lighting;
let renderer,camera,scene,views,pending,active=false,paused=false,selected,serial=0,drag=null;
let dirty=true;
let yaw=0,pitch=0,prev=0,frames=0,last=0;
const keys=new Set(),meshes=[],ray=new T.Raycaster(),origin=new T.Vector3(),dir=new T.Vector3(),down=new T.Vector3(0,-1,0);
ray.firstHitOnly=true;
const touch=matchMedia('(pointer:coarse)').matches;
let prefs={quality:'medium',fov:72,counter:false};
try{Object.assign(prefs,JSON.parse(localStorage.tapeSettings||'{}'));}catch{}
function resize(){ dirty=true;
  const v=$('viewport');if(!renderer||!v.clientWidth)return;
  renderer.setSize(v.clientWidth,v.clientHeight,false);camera.aspect=v.clientWidth/v.clientHeight;camera.updateProjectionMatrix();
}
function apply(){
  setInteriorQuality(prefs.quality);
  $('angle').value=prefs.fov+'°';$('fps').hidden=!prefs.counter;
  if(renderer){renderer.setPixelRatio(({low:.65,medium:1,high:1.5})[prefs.quality]||1);camera.fov=Number(prefs.fov);resize();}
}
for(const id of ['quality','fov','counter']){
  const input=$(id);if(id==='counter')input.checked=prefs[id];else input.value=prefs[id];
  input.oninput=()=>{prefs[id]=id==='counter'?input.checked:input.value;apply();try{localStorage.tapeSettings=JSON.stringify(prefs);}catch{}};
}
apply();window.addEventListener('resize',resize);
function panel(help){
  if(active)pause();$('panelTitle').textContent=help?'Управление':'Графика';$('options').hidden=help;$('instructions').hidden=!help;$('panel').showModal();
}
$('settings').onclick=()=>panel(false);$('help').onclick=()=>panel(true);$('close').onclick=()=>$('panel').close();
$('enter').onclick=()=>start('Атриум');
async function load(){
  if(!renderer){
    renderer=new T.WebGLRenderer({antialias:true,powerPreference:'high-performance'});$('viewport').append(renderer.domElement);
    scene=new T.Scene();scene.background=new T.Color(0xcbd9db);camera=new T.PerspectiveCamera(72,1,.1,350);camera.rotation.order='YXZ';

    scene.add(camera);apply();
  }
  const [g,v]=await Promise.all([new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync('school.glb',e=>{if(e.total)$('resume').textContent='Загрузка · '+Math.round(e.loaded*100/e.total)+'%';}),fetch('views.json').then(r=>r.json()), lighting ??= lightInterior(renderer,scene).catch(e=>{ lighting=null; throw e; })]);
  await finishSurfaces(g.scene,renderer);views=v;scene.add(g.scene);g.scene.updateMatrixWorld(true);
  g.scene.traverse(m=>{m.matrixAutoUpdate=false;if(m.isMesh){if(!m.geometry.boundsTree)computeBoundsTree.call(m.geometry);meshes.push(m);}});
}
function hit(p,d,far){ray.set(p,d);ray.far=far;return ray.intersectObjects(meshes,false)[0];}
const eye=1.24;
const bodyRadius=0.175;
// Jumping: vertical speed, ground contact and time in the air (respawn if we fall out of the model).
const gravity=9.8,jumpSpeed=3.7,up=new T.Vector3(0,1,0);
let vy=0,grounded=true,airTime=0;
// Flight: F toggles, Space up, C down; walls still block, floors and ceilings stop you.
let flying=false;
// Grid ceilings have gaps a single ray slips through, so above 2.6 m over the floor
// flying is allowed only where the space above is open (atrium); no floor below = outside.
const probe=new T.Vector3();
function headroom(x,y,z){probe.set(x,y,z);const f=hit(probe,down,14);if(!f)return false;if(y-f.point.y<=2.6)return true;return !hit(probe,up,2.5);}
function setFlying(on){flying=on;vy=0;airTime=0;if(!on)grounded=false;$('flyBadge').hidden=!on;$('padDown').hidden=!on;$('padFly').classList.toggle('on',on);dirty=true;}
function look(){dirty=true;camera.rotation.set(pitch,yaw,0,'YXZ');}
function spawn(){
  const v=views.find(p=>p.name===selected)||views[0];camera.position.fromArray(v.position);
  const floor=hit(camera.position,down,2.5);if(floor)camera.position.y=floor.point.y+eye;
  const [x,y,z]=v.direction;yaw=Math.atan2(-x,-z);pitch=Math.asin(y);vy=0;grounded=true;airTime=0;if(flying)setFlying(false);look();
}
async function start(name){
  const seq=++serial;selected=name;$('place-name').textContent=name;$('home').hidden=true;$('tour').hidden=false;$('resume').hidden=false;$('resume').disabled=true;$('resume').textContent='Загрузка модели…';
  try{
    pending??=load().catch(e=>{pending=null;throw e;});await pending;if(seq!==serial)return;
    resize();spawn();active=true;paused=false;$('resume').hidden=true;$('resume').disabled=false;$('pad').hidden=!touch;prev=performance.now();renderer.setAnimationLoop(frame);
  }catch(e){if(seq!==serial)return;console.error(e);$('resume').disabled=false;$('resume').textContent='Не удалось открыть 3D · Повторить';}
}
$('leave').onclick=()=>{++serial;active=false;keys.clear();drag=null;if(document.pointerLockElement)document.exitPointerLock();renderer?.setAnimationLoop(null);$('tour').hidden=true;$('home').hidden=false;$('enter').focus();};
function pause(){paused=true;keys.clear();drag=null;if(document.pointerLockElement)document.exitPointerLock();$('resume').textContent='Продолжить прогулку';$('resume').hidden=false;}
$('snap').onclick=()=>{const y=camera.position.y;$('leave').onclick();prefillPlace(selected,y);};
$('reset').onclick=()=>{if(active)spawn();};
function lock(){if(!touch&&!document.pointerLockElement){try{renderer.domElement.requestPointerLock?.()?.catch(()=>{});}catch{}}}
$('resume').onclick=()=>{if(!active){start(selected);return;}paused=false;$('resume').hidden=true;lock();};
document.addEventListener('pointerlockchange',()=>{if(!document.pointerLockElement&&active)pause();});
function rotate(x,y){yaw-=x*.0023;pitch=T.MathUtils.clamp(pitch-y*.0023,-1.48,1.48);look();}
$('viewport').onpointerdown=e=>{if(!active||paused)return;drag=[e.clientX,e.clientY];e.target.setPointerCapture(e.pointerId);lock();};
$('viewport').onpointermove=e=>{if(drag&&!paused&&!document.pointerLockElement){rotate(e.clientX-drag[0],e.clientY-drag[1]);drag=[e.clientX,e.clientY];}};
$('viewport').onpointerup=$('viewport').onpointercancel=()=>drag=null;
document.onmousemove=e=>{if(active&&!paused&&document.pointerLockElement)rotate(e.movementX,e.movementY);};
window.addEventListener('keydown',e=>{if(!active||paused||$('panel').open)return;if(e.code==='Escape'){pause();return;}if(e.code==='KeyF'){e.preventDefault();if(!e.repeat)setFlying(!flying);return;}if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight','Space','KeyC'].includes(e.code)){e.preventDefault();keys.add(e.code);}});
window.addEventListener('keyup',e=>keys.delete(e.code));window.addEventListener('blur',()=>{if(active)pause();});
$('padFly').onpointerdown=e=>{e.preventDefault();setFlying(!flying);};
for(const b of $('pad').querySelectorAll('[data-key]')){b.onpointerdown=e=>{e.preventDefault();b.setPointerCapture(e.pointerId);keys.add(b.dataset.key);};b.onpointerup=b.onpointercancel=()=>keys.delete(b.dataset.key);}
function move(dx,dz){
  const p=camera.position,dist=Math.hypot(dx,dz);if(!dist)return;
  dir.set(dx/dist,0,dz/dist);
  for(const height of [-eye+.38,.055]){origin.copy(p);origin.y+=height;if(hit(origin,dir,dist+bodyRadius))return;}
  if(flying){if(headroom(p.x+dx,p.y,p.z+dz)){p.x+=dx;p.z+=dz;dirty=true;}return;}
  origin.set(p.x+dx,p.y-eye+.32,p.z+dz);
  if(grounded){const floor=hit(origin,down,.88);if(floor){p.set(origin.x,floor.point.y+eye,origin.z);dirty=true;}return;}
  // In the air: allow the step only above solid ground, so a jump never carries you off a gallery.
  if(hit(origin,down,1.7)){p.x=origin.x;p.z=origin.z;dirty=true;}
}
function vertical(dt){
  const p=camera.position;
  if(flying){
    const v=Number(keys.has('Space'))-Number(keys.has('KeyC'));if(!v)return;
    const dy=v*(keys.has('ShiftLeft')||keys.has('ShiftRight')?5:2.8)*dt;dirty=true;
    if(dy>0){if(!hit(p,up,dy+.15)&&headroom(p.x,p.y+dy,p.z))p.y+=dy;return;}
    const floor=hit(p,down,eye-dy);
    p.y=floor&&p.y+dy<floor.point.y+eye?floor.point.y+eye:p.y+dy;return;
  }
  if(keys.has('Space')&&grounded){vy=jumpSpeed;grounded=false;airTime=0;}
  if(grounded){
    origin.set(p.x,p.y-eye+.32,p.z);
    if(!hit(origin,down,.88)){grounded=false;vy=0;airTime=0;}
    return;
  }
  airTime+=dt;vy-=gravity*dt;const dy=vy*dt;dirty=true;
  if(dy>0){origin.copy(p);if(hit(origin,up,dy+.12))vy=0;else p.y+=dy;return;}
  origin.set(p.x,p.y-eye+.05,p.z);const floor=hit(origin,down,-dy+.06);
  if(floor){p.y=floor.point.y+eye;vy=0;grounded=true;}
  else{p.y+=dy;if(airTime>4)spawn();}
}
function frame(time){
  const dt=Math.min((time-prev)/1000,.05);prev=time;
  if(!paused){
    const f=Number(keys.has('KeyW')||keys.has('ArrowUp'))-Number(keys.has('KeyS')||keys.has('ArrowDown'));
    const s=Number(keys.has('KeyD')||keys.has('ArrowRight'))-Number(keys.has('KeyA')||keys.has('ArrowLeft'));
    const step=(keys.has('ShiftLeft')||keys.has('ShiftRight')?(flying?7:4.5):(flying?3.5:2.6))*dt/(Math.hypot(f,s)||1);
    move((s*Math.cos(yaw)-f*Math.sin(yaw))*step,0);move(0,(-s*Math.sin(yaw)-f*Math.cos(yaw))*step);
    if (!grounded || flying || f || s || keys.has('Space')) vertical(dt);
  }
  if(dirty){renderer.render(scene,camera);dirty=false;}frames++;if(time-last>650){$('fps').textContent=Math.round(frames*1000/(time-last))+' FPS';last=time;frames=0;}
}



