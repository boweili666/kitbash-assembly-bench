"""Auto-align then group regression. Pass a served simulator URL; requires Playwright."""
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
 for name,offset,outside,reverse,missing,expected in [('exact',0,False,False,False,1),('approx',4,False,False,False,1),('too far',12,False,False,False,2),('outside',0,True,False,False,2),('reversed',0,False,True,False,2),('missing',0,False,False,True,1)]:
  result=page.evaluate('''([offset,outside,reverse,missing])=>{fixture(offset,outside,reverse,missing);let before=poses();KB.pushSnapshot();let after=poses();let drift=Math.max(...Object.keys(before).flatMap(id=>before[id].map((v,i)=>Math.abs(v-after[id][i]))));return {roots:KB.objectsRoot.children.length,group:!KB.isPart(KB.objectsRoot.children[0]),drift,state:KBCheck.evaluate().steps[0].state,complete:KBCheck.results().stepsComplete}}''',[offset,outside,reverse,missing])
  print(name,result);assert result['roots']==expected and (name=='approx' or result['drift']<1e-9)
  assert result['group']==(name in ['exact','approx'])
  if name=='approx':assert result['complete']>=1 and result['drift']>0
 # One undo restores ungrouped placement; redo restores the assembly.
 page.evaluate('fixture();KB.pushSnapshot()');page.keyboard.press('Control+z');assert page.evaluate('KB.objectsRoot.children.length')==2
 page.keyboard.press('Control+Shift+z');assert page.evaluate('KB.objectsRoot.children.length')==1
 page.evaluate('KB.setSelection([KB.objectsRoot.children[0]])');page.locator('#btnUngroup').click();assert page.evaluate('KB.objectsRoot.children.length')==2
 page.wait_for_timeout(600);assert page.evaluate('KB.objectsRoot.children.length')==2
 page.evaluate('KB.pushSnapshot()');assert page.evaluate('KB.objectsRoot.children.length')==1
 assert page.evaluate('''()=>{let a=JSON.stringify(KB.serializeScene());KB.pushSnapshot();return a===JSON.stringify(KB.serializeScene())}''')
 assert page.evaluate('''()=>{let data=KB.serializeScene();KB.loadSceneData(data,true);return KB.objectsRoot.children.length===1&&KB.objectsRoot.children[0].children.length===2}''')
 result=page.evaluate("""()=>{
  const parts=KBParts.answer().parts.filter(d=>d.step<=2);
  KB.loadSceneData({objects:parts.map(d=>{let t=KBParts.nodeTransform(d.key,d.path[d.path.length-1]);return {id:KB.newId(),type:'part:'+d.key,name:d.name,p:t.p,r:t.r,s:[1,1,1]}})},true);
  let c=new THREE.Box3().setFromObject(KB.objectsRoot).getCenter(new THREE.Vector3());
  KB.objectsRoot.children.forEach(n=>{n.position.x+=13-c.x;n.position.z-=c.z;n.updateMatrixWorld(true)});
  let add=KB.objectsRoot.children.find(n=>n.userData.kbType==='part:aluminum_x_lock'),home=add.position.clone();add.position.z+=3;add.updateMatrixWorld(true);
  KB.resetHistory();KB.pushSnapshot();let initial=KB.objectsRoot.children.length;
  add.position.copy(home);add.position.x+=4.8*KBParts.unitScale()/1000;add.updateMatrixWorld(true);KB.pushSnapshot();let merged=KB.objectsRoot.children.length;
  let before=poses(),g=KB.objectsRoot.children[0];g.position.x+=.5;g.updateMatrixWorld(true);KB.pushSnapshot();let after=poses();
  let moved=Object.keys(before).every(id=>Math.abs(after[id][12]-before[id][12]-.5)<1e-8);
  return {initial,merged,moved};
 }""")
 print('merge/move',result);assert result=={'initial':3,'merged':1,'moved':True},result
 result=page.evaluate("""()=>{
  fixture(4);let before=poses(),fn=KB.groupNodes;KB.groupNodes=()=>null;
  try {KB.pushSnapshot()} finally {KB.groupNodes=fn}
  let after=poses();return {roots:KB.objectsRoot.children.length,unchanged:Object.keys(before).every(id=>before[id].every((v,i)=>Math.abs(v-after[id][i])<1e-9))};
 }""")
 assert result=={'roots':2,'unchanged':True},result
 print('PASS: exact/approx, correction before grouping, rollback on failure, wrong/missing/outside exclusions, undo/redo, manual ungroup, no repeated nesting, persistence.');assert not errors,errors
 b.close()
