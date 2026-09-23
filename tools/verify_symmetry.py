"""Symmetry and Next regression; pass a served simulator URL (requires Playwright)."""
import sys
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader'])
 page=b.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8144/?practice=1');page.wait_for_function('window.KBParts&&KBParts.ready()')
 page.evaluate('''()=>{
 window.fixture=(offset=0,outside=false,reverse=false,missing=false)=>{
  let parts=KBParts.answer().parts.filter(d=>d.step===0);if(missing)parts=parts.slice(0,1);
  KB.loadSceneData({objects:parts.map(d=>{let t=KBParts.nodeTransform(d.key,d.path[d.path.length-1]);return {id:KB.newId(),type:'part:'+d.key,name:d.name,p:t.p,r:t.r,s:[1,1,1]}})},true);
  KB.objectsRoot.children.forEach(n=>{if(n.userData.kbPending)KBParts.resolve(n)});
  let c=new THREE.Box3().setFromObject(KB.objectsRoot).getCenter(new THREE.Vector3());
  KB.objectsRoot.children.forEach(n=>{n.position.x+=(outside?0:13)-c.x;n.position.z-=c.z;n.updateMatrixWorld(true)});
  let n=KB.objectsRoot.children[1];if(n){n.position.x+=offset*KBParts.unitScale()/1000;if(reverse)n.rotateZ(Math.PI);n.updateMatrixWorld(true)}
  KB.resetHistory();
 };
 window.poses=()=>{let r={};KB.objectsRoot.traverse(n=>{if(KB.isPart(n)){n.updateWorldMatrix(true,false);r[n.userData.kbId]=n.matrixWorld.elements.slice()}});return r};
 }''')
 for angle in [0,13,37,89,123,180,271,359]:
  for wedge in [False,True]:
   r=page.evaluate("""([angle,wedge])=>{
    fixture();const nodes=KB.objectsRoot.children.slice();
    function rotate(n,axis,center,angle){n.updateMatrix();const c=new THREE.Vector3().fromArray(center);const S=new THREE.Matrix4().makeTranslation(c.x,c.y,c.z).multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3().fromArray(axis).normalize(),angle)).multiply(new THREE.Matrix4().makeTranslation(-c.x,-c.y,-c.z));n.matrix.multiply(S);n.matrix.decompose(n.position,n.quaternion,n.scale);n.updateMatrixWorld(true)}
    let screw=nodes.find(n=>n.userData.kbType.includes('screw'));let spec=KBParts.spec(screw.userData.kbType.slice(5));rotate(screw,spec.pegs[0].d,spec.pegs[0].c,angle*Math.PI/180);
    if(wedge){let w=nodes.find(n=>!n.userData.kbType.includes('screw'));let sp=KBParts.spec(w.userData.kbType.slice(5));rotate(w,sp.sym[0].axis,sp.sym_center,Math.PI)}
    let res=KBCheck.evaluate();let state=res.steps[0].state;
    KBAnswer.showStep(0);KB.pushSnapshot();return {state,roots:KB.objectsRoot.children.length,issues:res.issues.map(i=>i.msg)};
   }""",[angle,wedge]);assert r['state']=='complete' and r['roots']==1,(angle,wedge,r)
 print('PASS arbitrary screw roll and combined wedge 180-degree symmetry: completion + grouping')
 page.wait_for_timeout(600)
 assert page.evaluate('!KBAnswer.focus() || KBAnswer.focus().step!==0')
 page.evaluate("""()=>{
  fixture();let screw=KB.objectsRoot.children.find(n=>n.userData.kbType.includes('screw'));window.finalScrew=screw;window.finalPose=screw.position.clone();screw.position.x+=.25;screw.updateMatrixWorld(true);KBAnswer.showStep(0);
 }""")
 assert page.evaluate('KBAnswer.focus().step')==0
 page.evaluate('finalScrew.position.copy(finalPose);finalScrew.rotateY(.37);finalScrew.updateMatrixWorld(true);KB.pushSnapshot()')
 page.wait_for_timeout(650)
 assert page.evaluate('!KBAnswer.focus() || KBAnswer.focus().step!==0')
 print('PASS completed step stops even if next step has no available parts')
 assert not errors,errors
 b.close()
