(function () {
  'use strict';
  const data = window.DRONE_INTRO_DATA, T = THREE;
  const stage = document.getElementById('stage');
  let renderer;
  try { renderer = new T.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' }); }
  catch (_) { document.getElementById('caption').hidden = true; return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.4));
  renderer.outputEncoding = T.sRGBEncoding; renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = .95;
  stage.appendChild(renderer.domElement);
  const scene = new T.Scene(), camera = new T.PerspectiveCamera(34, 1, .1, 100);
  const rig = new T.Group(); scene.add(rig);
  scene.add(new T.HemisphereLight(0xc0e5ff, 0x27394b, .8));
  function light(color, strength, pos) { const l = new T.DirectionalLight(color, strength); l.position.fromArray(pos); scene.add(l); }
  light(0xf7dfb4, 1.1, [5,8,4]); light(0x76cfff, 1.0, [-6,3,-6]); light(0xffffff, .6, [0,-2,7]);
  const loader = new T.GLTFLoader(), models = {}, specs = Object.fromEntries(data.parts.map(p => [p.key,p]));
  const items = [], lines = [], geometries = new Set(), materials = new Set();
  const S = data.unitScale, mm = S/1000;
  function decode(b64) { const s=atob(b64), b=new Uint8Array(s.length); for(let i=0;i<s.length;i++)b[i]=s.charCodeAt(i);return b.buffer; }
  function load(spec) { return new Promise((resolve,reject)=>loader.parse(decode(data.files[spec.file]),'',gltf=>{
    gltf.scene.updateMatrixWorld(true); const meshes=[];
    gltf.scene.traverse(o=>{if(!o.isMesh)return;const geo=o.geometry.clone();geo.applyMatrix4(new T.Matrix4().makeScale(S,S,S).multiply(o.matrixWorld));geometries.add(geo);
      const source=Array.isArray(o.material)?o.material[0]:o.material;
      const mat=new T.MeshPhongMaterial({color:source.color.clone(),specular:0x243747,shininess:70,side:T.DoubleSide});
      if(/plate|arm_5in/.test(spec.key)){mat.color.set(0x485968);}
      else if(/screw|standoff|nut/.test(spec.key)){mat.color.set(0xb5c8ce);}
      else if(/wedge|x_lock/.test(spec.key)){mat.color.set(0xc8aa74);}
      else if(/propeller/.test(spec.key)){mat.color.set(0x7198a7);}
      mat.color.convertSRGBToLinear();
      geo.computeVertexNormals();
      materials.add(mat);meshes.push({geo,mat});
    });models[spec.key]=meshes;resolve();},reject)); }
  // 参考装配是在台面上翻过来采的(电机、立柱、顶板、桨都朝下)。封面要看飞行姿态,
  // 所以摆零件时先把位姿翻 180°。注意不能去转 rig —— 那会把下面"抬起再落下"
  // 的动画偏移也一起转反,桨会朝地上飞
  const FLIP = new T.Quaternion().setFromAxisAngle(new T.Vector3(1,0,0), Math.PI);
  function upright(pos,q){ return { p: pos.clone().applyQuaternion(FLIP), q: FLIP.clone().multiply(q) }; }
  function make(key,name,pos,q) { const u=upright(pos,q); pos=u.p; q=u.q; const node=new T.Group();node.name=name;models[key].forEach(p=>node.add(new T.Mesh(p.geo,p.mat)));node.position.copy(pos);node.quaternion.copy(q);rig.add(node);const item={key,node,home:pos.clone(),q:q.clone(),offset:new T.Vector3(),delay:0};items.push(item);return item; }
  function smooth(x){x=Math.max(0,Math.min(1,x));return x*x*x*(x*(x*6-15)+10);}
  // 封面循环整体放快:时间轴上的节拍不变,只是走得更快(24 s -> 15 s)
  const SPEED=1.6;
  let elapsed=0,last=0,raf=0,ready=false,hostVisible=true,userPlaying=true,disposed=false;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let bounds, center, span=8;
  function resize(){const w=innerWidth,h=innerHeight;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();if(ready)draw();}
  function draw(){
    const time=reduced.matches?0:elapsed%24;
    const spread=time<4?0:time<10?smooth((time-4)/6):time<13?1:time<20?1-smooth((time-13)/7):0;
    items.forEach((it,i)=>{
      const local=time>=13&&time<21?1-smooth((time-13-it.delay)/5.8):spread;
      it.node.position.copy(it.home).addScaledVector(it.offset,Math.max(0,Math.min(1,local)));
      // A small axial turn unwinds during assembly without changing final orientation.
      it.node.quaternion.copy(it.q);
      if(/screw/.test(it.key)&&local>0)it.node.rotateOnAxis(new T.Vector3().fromArray((specs[it.key].pegs[0]||{d:[0,1,0]}).d),local*Math.PI*.75);
    });
    lines.forEach(l=>{const it=l.userData.item;l.material.opacity=.13*spread;const a=it.home.clone().sub(center),b=it.node.position.clone().sub(center);l.geometry.setFromPoints([a,b]);});
    const orbit=time/24*Math.PI*2;
    // One continuous closed camera path: establish, rise into the exploded stack,
    // glide past the motor quadrant, then return to the original three-quarter view.
    const angle=.65+Math.sin(orbit)*.28;
    const narrow=camera.aspect<.85;
    const distance=span*(narrow?2.45:1.72)*(1+.30*spread-.08*Math.sin(orbit));
    camera.position.set(Math.sin(angle)*distance, distance*(.64+.12*Math.sin(orbit-.4)),Math.cos(angle)*distance);
    camera.lookAt(new T.Vector3(0,.2+spread*.9,0));
    camera.setViewOffset(innerWidth,innerHeight,narrow?0:-innerWidth*.14,narrow?innerHeight*.24:0,innerWidth,innerHeight);
    renderer.render(scene,camera);
    const chapter=time<4?['01 / FORM','PRECISION IN EVERY PART']:time<13?['02 / ANATOMY','ENGINEERED FROM THE INSIDE']:time<20?['03 / ASSEMBLY','EVERY PIECE FINDS ITS PLACE']:['04 / READY','YOUR BUILD STARTS HERE'];
    document.getElementById('chapter').textContent=chapter[0];document.getElementById('detail').textContent=chapter[1];document.querySelector('#timeline i').style.width=(time/24*100)+'%';
  }
  function tick(now){raf=0;if(!ready||disposed||document.hidden||!hostVisible||!userPlaying||reduced.matches){last=0;return;}if(!last)last=now;const dt=now-last;if(dt>=1000/45){elapsed+=dt/1000*SPEED;last=now;draw();}raf=requestAnimationFrame(tick);}
  function resume(){cancelAnimationFrame(raf);raf=0;last=0;if(ready){draw();if(!document.hidden&&hostVisible&&userPlaying&&!reduced.matches)raf=requestAnimationFrame(tick);}}
  window.addEventListener('message',e=>{if(e.source!==parent||!e.data||e.data.type!=='aristos:intro-motion')return;userPlaying=e.data.playing!==false;hostVisible=e.data.visible!==false;resume();});
  document.addEventListener('visibilitychange',resume);reduced.addEventListener('change',resume);window.addEventListener('resize',resize);
  renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();cancelAnimationFrame(raf);ready=false;document.getElementById('caption').hidden=true;});
  window.addEventListener('pagehide',()=>{disposed=true;cancelAnimationFrame(raf);geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());renderer.dispose();});
  resize();
  Promise.all(data.parts.map(load)).then(()=>{
    if(disposed)return;
    data.answer.parts.forEach(p=>{const w=p.path[p.path.length-1];make(p.key,p.name,new T.Vector3(w.x*mm,w.y*mm,w.z*mm),new T.Quaternion().setFromEuler(new T.Euler(w.roll,w.pitch,w.yaw,'XYZ')));});
    // Additional actual kit models complete the decorative silhouette. Their
    // presentation-only mounts never enter the simulator's assembly state.
    rig.updateMatrixWorld(true);
    // 参考装配现在自带螺旋桨和顶板了(推导补的),再摆一套就会一个电机顶两个桨
    const hasProps=items.some(it=>/propeller/.test(it.key));
    const hasTop=items.some(it=>it.key==='top_plate');
    const motors=hasProps?[]:items.filter(it=>it.key==='motor_2207');
    motors.forEach((motor,i)=>{const key=i%2?'propeller_ccw':'propeller_cw';const b=new T.Box3().setFromObject(motor.node),c=b.getCenter(new T.Vector3());const q=new T.Quaternion().setFromUnitVectors(new T.Vector3(0,0,1),new T.Vector3(0,1,0));q.premultiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),i*.65));const spec=specs[key],hub=new T.Vector3().fromArray(spec.holes[0].c).add(new T.Vector3().fromArray(spec.offset).multiplyScalar(S)).applyQuaternion(q);make(key,'Propeller '+(i+1),new T.Vector3(c.x,b.max.y+.055,c.z).sub(hub),q);});
    if(!hasTop){const standoffs=items.filter(it=>it.key==='knurled_standoff');const topY=Math.max(...standoffs.map(it=>new T.Box3().setFromObject(it.node).max.y));make('top_plate','Top plate',new T.Vector3(0,topY+.015,0),new T.Quaternion());}
    rig.updateMatrixWorld(true);bounds=new T.Box3().setFromObject(rig);center=bounds.getCenter(new T.Vector3());span=Math.max(bounds.max.x-bounds.min.x,bounds.max.z-bounds.min.z);rig.position.copy(center).negate();
    items.forEach((it,i)=>{const box=new T.Box3().setFromObject(it.node),c=box.getCenter(new T.Vector3()).add(center);const radial=new T.Vector3(c.x,0,c.z);if(radial.length()>.4)radial.normalize();
      let lift=.25;if(/arm_5in/.test(it.key)){it.offset.copy(radial).multiplyScalar(.65);lift=-.4;it.delay=.1;}
      else if(/motor/.test(it.key)){it.offset.copy(radial).multiplyScalar(.9);lift=1.5;it.delay=.8;}
      else if(/propeller/.test(it.key)){it.offset.copy(radial).multiplyScalar(.9);lift=2.5;it.delay=1.5;}
      else if(/top_plate/.test(it.key)){lift=3.1;it.delay=1.8;}
      else if(/esc|damper|standoff/.test(it.key)){lift=1.2;it.delay=.65;}
      else if(/screw|nut/.test(it.key)){it.offset.copy(radial).multiplyScalar(.6);lift=1.5+(i%3)*.2;it.delay=1.1;}
      else if(/front_plate|rear_plate/.test(it.key)){lift=-.8;}
      it.offset.y=lift;
      if(/arm_5in|motor_2207|top_plate|esc_4in1/.test(it.key)){const mat=new T.LineBasicMaterial({color:0xd8b786,transparent:true,opacity:0,depthWrite:false});const geo=new T.BufferGeometry().setFromPoints([new T.Vector3(),new T.Vector3()]);const line=new T.Line(geo,mat);line.userData.item=it;scene.add(line);lines.push(line);materials.add(mat);geometries.add(geo);}
    });
    window.INTRO={scene,rig,items,camera};   // 调试用:量各零件的世界高度
    ready=true;document.body.dataset.ready='true';document.body.dataset.parts=items.length;resume();
  }).catch(()=>{document.getElementById('caption').hidden=true;});
})();
