import { parseFrontMatter, parseDocument, validateDocument, loadMigrationMap, validateMigrationMap, resolveCanonicalDocument, validatePlanLifecycle } from './docs-governance-lib.mjs';
import assert from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('parseFrontMatter extracts metadata and body', () => {
  const text = '---\nid: roadmap-01\nkind: roadmap\ntitle: Test\nstatus: draft\ncreated: 2024-01-01\nupdated: 2024-01-02\n---\nActual content';
  const { data, body } = parseFrontMatter(text);
  assert.strictEqual(data.id, 'roadmap-01');
  assert.strictEqual(data.kind, 'roadmap');
  assert.strictEqual(body, 'Actual content');
});

test('parseDocument parses file content', () => {
  const doc = parseDocument('test.md', '---\nid: spec-02\nkind: spec\ntitle: API Spec\nstatus: in-progress\ncreated: 2024-01-01\nupdated: 2024-01-02\n---\nText');
  assert.strictEqual(doc.kind, 'spec');
  assert.strictEqual(doc.status, 'in-progress');
});

test('validateDocument returns empty for valid document', () => {
  const record = { id: 'plan-01', kind: 'plan', title: 'Plan', status: 'approved', created: '2024-01-01', updated: '2024-01-02', depends_on: [], specs: [], evidence: [], body: '', filePath: 'test.md' };
  const issues = validateDocument(record, []);
  assert.strictEqual(issues.length, 0);
});

test('validateDocument returns issues for invalid id', () => {
  const record = { id: 'invalid', kind: 'plan', title: 'Plan', status: 'approved', created: '2024-01-01', updated: '2024-01-02', depends_on: [], specs: [], evidence: [], body: '', filePath: 'test.md' };
  const issues = validateDocument(record, []);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].field, 'id');
});

test('loadMigrationMap parses migration document', async () => {
  const map = await loadMigrationMap('./docs/architecture/plans/governance/evidence/03-document-migration-map.md');
  assert.ok(map.entries.length > 0);
  assert.ok(map.entries[0].oldPath);
  assert.ok(map.entries[0].newPath);
  assert.ok(map.entries[0].action);
});

test('loadMigrationMap does not require the legacy roadmap-stage column', async () => {
  const dir=await mkdtemp(join(tmpdir(),'ebb-migration-map-'));
  const path=join(dir,'migration.md');
  try {
    await writeFile(path,[
      '| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |',
      '|---|---|---|---|---|---|---|---|---|---|',
      '| docs/old-a.md | docs/new-a.md | merge | plan | 01 | 2026-09-20 | docs/new-a.md | decision-a | update-a | preserve-a |',
      '',
      '| old path | new path | action | kind | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |',
      '|---|---|---|---|---|---|---|---|---|',
      '| docs/old-b.md | docs/new-b.md | move | plan | 2026-09-21 | docs/new-b.md | decision-b | update-b | preserve-b |'
    ].join('\n'));
    const map=await loadMigrationMap(path);
    assert.deepStrictEqual(map.entries,[
      {oldPath:'docs/old-a.md',newPath:'docs/new-a.md',action:'merge',kind:'plan',sourceDate:'2026-09-20',canonicalTarget:'docs/new-a.md',conflictDecision:'decision-a',dependentLinksUpdate:'update-a',evidencePreservation:'preserve-a'},
      {oldPath:'docs/old-b.md',newPath:'docs/new-b.md',action:'move',kind:'plan',sourceDate:'2026-09-21',canonicalTarget:'docs/new-b.md',conflictDecision:'decision-b',dependentLinksUpdate:'update-b',evidencePreservation:'preserve-b'}
    ]);
    assert.ok(map.entries.every(entry=>!Object.hasOwn(entry,'roadmapStage')));
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('validateMigrationMap checks source paths exist', async () => {
  const inventory = [{ filePath: 'docs/README.md', id: 'index-00', kind: 'index', title: 'Docs', status: 'approved', created: '2026-01-01', updated: '2026-01-01', depends_on: [], specs: [], evidence: [], body: '' }];
  const map = await loadMigrationMap('./docs/architecture/plans/governance/evidence/03-document-migration-map.md');
  const issues = await validateMigrationMap(map, inventory);
  assert.ok(issues.some(i => i.field === 'incomplete_mapping'));
});

test('resolveCanonicalDocument finds canonical target', async () => {
  const result = await resolveCanonicalDocument('docs/architecture/plans/2026-09-16-v1-roadmap.md');
  assert.strictEqual(result.action, 'merge');
  assert.ok(result.target);
});

// Tests for Roadmap Model building and rendering
test('buildRoadmapModel projects only Plans and dependencies', async () => {
  const { buildRoadmapModel } = await import('./docs-governance-lib.mjs');
  const model=buildRoadmapModel([
    {id:'plan-01',kind:'plan',title:'Plan',status:'completed',depends_on:['plan-00']},
    {id:'ledger-01',kind:'ledger',title:'Ledger',status:'draft'},
    {id:'proposal-01',kind:'proposal',title:'Proposal',status:'approved'},
    {id:'roadmap-01',kind:'roadmap',title:'Legacy roadmap',status:'approved'}
  ]);
  assert.deepStrictEqual(Object.keys(model).sort(),['generatedAt','plans']);
  assert.deepStrictEqual(model.plans,[{id:'plan-01',status:'completed',title:'Plan',depends_on:['plan-00']}]);
});

test('renderRoadmap generates Plan-only sections with markers', async () => {
  const { renderRoadmap } = await import('./docs-governance-lib.mjs');
  const model = {
    generatedAt: '2024-01-02',
    plans: [{ id: 'plan-01', status: 'completed', title: 'Plan Fixture', depends_on: ['plan-00'] }],
    stages: [{ stage: '01' }],
    proposals: [{ id: 'proposal-01', status: 'approved', title: 'Proposal Fixture' }],
    roadmap: [{ id: 'roadmap-01', title: 'Roadmap Fixture' }]
  };
  const output = renderRoadmap(model);
  assert.ok(output.includes('<!-- BEGIN GENERATED'));
  assert.ok(output.includes('<!-- END GENERATED'));
  assert.ok(output.includes('plan-01 | completed | Plan Fixture'));
  assert.ok(output.includes('plan-00 → plan-01'));
  assert.doesNotMatch(output,/stage|proposal-01|roadmap-01/i);
});

test('isGeneratedRoadmapUpToDate checks for matching content', async () => {
  const { isGeneratedRoadmapUpToDate } = await import('./docs-governance-lib.mjs');
  const existing = 'some content';
  const expected = 'some content';
  assert.ok(isGeneratedRoadmapUpToDate(existing, expected));
});

test('writeGeneratedRoadmap writes file to path', async () => {
  const { writeGeneratedRoadmap } = await import('./docs-governance-lib.mjs');
  const tempDir = await mkdtemp(join(tmpdir(), 'ebb-docs-test-'));
  try {
    const roadmapPath = join(tempDir, 'roadmap-test.md');
    await writeGeneratedRoadmap(roadmapPath, 'test content');
    assert.ok((await readFile(roadmapPath, 'utf-8')).includes('test content'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Plan lifecycle helper validates enum and ignores non-Plan', () => {
  for (const status of ['proposed','planned','in_progress','blocked','completed','superseded','cancelled']) assert.deepEqual(validatePlanLifecycle({kind:'plan',status}), []);
  for (const status of [undefined,'draft','bad']) assert.equal(validatePlanLifecycle({kind:'plan',status}).length, 1);
  const ledger={kind:'ledger',status:'draft'}; assert.deepEqual(validatePlanLifecycle(ledger), []); assert.deepEqual(ledger,{kind:'ledger',status:'draft'});
});

test('Plan metadata helper enforces contract', async () => {
  const { validatePlanMetadata, PlanMetadataError } = await import('./docs-governance.mjs');
  const valid=()=>({id:'plan-91',kind:'plan',status:'planned',title:'Fixture',created:'2026-09-25',updated:'2026-09-26'});
  assert.deepEqual(validatePlanMetadata(valid()),valid());
  assert.deepEqual(validatePlanMetadata({...valid(),summary:'s',depends_on:['plan-90'],specs:['spec-01'],evidence:['e.md']}),{...valid(),summary:'s',depends_on:['plan-90'],specs:['spec-01'],evidence:['e.md']});
  for(const key of ['id','kind','status','title','created','updated']) { const m=valid(); delete m[key]; assert.throws(()=>validatePlanMetadata(m,'fixture'),e=>e instanceof PlanMetadataError && e.source==='fixture' && e.message.includes(`missing ${key}`)); }
  for(const key of ['id','kind','status','title','created','updated']) { const m=valid(); m[key]=key==='kind'?'proposal':42; assert.throws(()=>validatePlanMetadata(m),PlanMetadataError); }
  for(const key of ['summary','depends_on','specs','evidence']) assert.throws(()=>validatePlanMetadata({...valid(),[key]:42}),PlanMetadataError);
  for(const status of ['proposed','planned','in_progress','blocked','completed','superseded','cancelled']) assert.equal(validatePlanMetadata({...valid(),status}).status,status);
  assert.throws(()=>validatePlanMetadata({...valid(),status:'draft'}),PlanMetadataError);
  for(const created of ['2026-02-30','2026-13-01','2026-2-01']) assert.throws(()=>validatePlanMetadata({...valid(),created}),PlanMetadataError);
  for(const key of ['roadmap','stage']) assert.throws(()=>validatePlanMetadata({...valid(),[key]:'01'}),PlanMetadataError);
});

test('collectPlans enforces the full Plan contract through YAML files', async () => {
  const { collectPlans, PlanMetadataError } = await import('./docs-governance.mjs');
  const dir=await mkdtemp(join(tmpdir(),'ebb-plan-matrix-'));
  const valid=(overrides={})=>({id:'plan-91',kind:'plan',status:'planned',title:'Fixture',created:'2026-09-25',updated:'2026-09-26',...overrides});
  const cases=[
    {name:'required-only',metadata:valid(),accepted:true},
    {name:'optional-fields',metadata:valid({summary:'Summary',depends_on:['plan-90'],specs:['spec-01'],evidence:['evidence.md']}),accepted:true},
    ...['proposed','planned','in_progress','blocked','completed','superseded','cancelled'].map(status=>({name:`status-${status}`,metadata:valid({status}),accepted:true}))
  ];
  for (const field of ['id','kind','status','title','created','updated']) {
    const metadata=valid({title:`missing-${field}`}); delete metadata[field];
    cases.push({name:`missing-${field}`,metadata,accepted:false});
  }
  const wrongTypes={id:42,kind:42,status:42,title:42,created:42,updated:42};
  for (const [field,value] of Object.entries(wrongTypes)) {
    const metadata=valid({title:`wrong-type-${field}`}); metadata[field]=value;
    cases.push({name:`wrong-type-${field}`,metadata,accepted:false});
  }
  cases.push({name:'invalid-kind',metadata:valid({kind:'unknown-kind'}),accepted:false});
  cases.push({name:'invalid-status',metadata:valid({status:'draft'}),accepted:false});
  for (const [field,value] of Object.entries({summary:42,depends_on:'plan-90',specs:42,evidence:42})) {
    cases.push({name:`wrong-optional-${field}`,metadata:valid({[field]:value}),accepted:false});
  }
  for (const [field,value] of [['created','2026-02-30'],['created','2026-13-01'],['updated','2026-2-01']]) {
    cases.push({name:`invalid-${field}-${value}`,metadata:valid({[field]:value}),accepted:false});
  }
  cases.push({name:'unknown-roadmap-field',metadata:valid({roadmap:'01'}),accepted:false});
  cases.push({name:'unknown-stage-field',metadata:valid({stage:'01'}),accepted:false});

  try {
    const warnings=[]; const original=console.warn; let plans;
    for (const [index,item] of cases.entries()) {
      item.path=join(dir,`${String(index).padStart(2,'0')}-fixture.md`);
      await writeFile(item.path,`---\n${JSON.stringify(item.metadata)}\n---\n`);
    }
    const ledgerPath=join(dir,'ledger.md');
    await writeFile(ledgerPath,`---\n${JSON.stringify({id:'ledger-01',kind:'ledger',status:'draft',title:'Ledger',created:'2026-09-25',updated:'2026-09-26'})}\n---\n`);
    const evidencePath=join(dir,'merge-decisions.md');
    await writeFile(evidencePath,`---\n${JSON.stringify({id:'plan-08-01-merge',kind:'governance-evidence',status:'superseded',title:'Historical merge evidence',type:'evidence'})}\n---\n`);
    const legacyEvidencePath=join(dir,'progress-ledger.md');
    await writeFile(legacyEvidencePath,`---\n${JSON.stringify({id:'plan-00-progress-ledger',status:'superseded',title:'Progress Ledger',type:'evidence'})}\n---\n`);
    console.warn=(...args)=>warnings.push(args);
    try { plans=collectPlans(dir); } finally { console.warn=original; }

    const accepted=cases.filter(item=>item.accepted);
    const rejected=cases.filter(item=>!item.accepted);
    assert.deepEqual(plans.map(plan=>plan.title).sort(),accepted.map(item=>item.metadata.title).sort());
    assert.equal(warnings.length,rejected.length);
    for (const item of rejected) {
      const warning=warnings.find(args=>String(args[0]).includes(item.path));
      assert.ok(warning,item.name);
      assert.equal(warning.length,1,item.name);
      assert.ok(String(warning[0]).startsWith(`Failed to parse plan file: ${item.path}:`),item.name);
    }
    assert.equal(warnings.some(args=>String(args[0]).includes(ledgerPath)),false);
    assert.equal(warnings.some(args=>String(args[0]).includes(evidencePath)),false);
    assert.equal(warnings.some(args=>String(args[0]).includes(legacyEvidencePath)),false);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('collectPlans warns and skips invalid Plan metadata while retaining Plans only', async () => {
  const { collectPlans, PlanMetadataError } = await import('./docs-governance.mjs');
  const dir=await mkdtemp(join(tmpdir(),'ebb-collector-'));
  try {
    const plan=(id,kind='plan',status='planned')=>`---\nid: ${id}\nkind: ${kind}\nstatus: ${status}\ntitle: Fixture\ncreated: 2026-09-25\nupdated: 2026-09-26\n---\n`;
    await writeFile(join(dir,'01-plan.md'),plan('plan-91'));
    await writeFile(join(dir,'02-ledger.md'),plan('ledger-01','ledger','draft'));
    await writeFile(join(dir,'03-invalid.md'),plan('plan-03','plan','draft'));
    await mkdir(join(dir,'nested'));
    await writeFile(join(dir,'nested','04-nested.md'),plan('plan-94'));
    await writeFile(join(dir,'05-not-markdown.txt'),plan('plan-95'));
    const warnings=[]; const original=console.warn; console.warn=(...args)=>warnings.push(args.join(' ')); let plans;
    try { plans=collectPlans(dir); } finally { console.warn=original; }
    assert.deepEqual(plans.map(item=>item.id),['plan-91']); assert.equal(warnings.length,1);
    assert.ok(warnings[0].includes(join(dir,'03-invalid.md'))); assert.ok(warnings[0].includes('invalid Plan status'));
    assert.ok(PlanMetadataError.prototype instanceof Error);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('check CLI uses temporary root, README exemption, and ordinary filename/lifecycle checks', async () => {
  const { spawnSync }=await import('child_process'); const { mkdir, writeFile }=await import('node:fs/promises');
  const root=await mkdtemp(join(tmpdir(),'ebb-docs-check-')); const cli=join(dirname(fileURLToPath(import.meta.url)),'docs-governance.mjs');
  const frontmatter=(id,kind,status='approved')=>`---\nid: ${id}\nkind: ${kind}\nstatus: ${status}\ntitle: Fixture\ncreated: 2026-09-25\nupdated: 2026-09-26\n---\n`;
  try {
    await mkdir(join(root,'docs/roadmap'),{recursive:true});
    await writeFile(join(root,'README.md'),'# root');
    await writeFile(join(root,'docs/README.md'),'# docs');
    await writeFile(join(root,'docs/bad.md'),'# invalid');
    await writeFile(join(root,'docs/01-spec-one.md'),frontmatter('spec-01','spec'));
    await writeFile(join(root,'docs/02-spec-two.md'),frontmatter('spec-02','spec'));
    await writeFile(join(root,'docs/03-plan-one.md'),frontmatter('plan-01','plan','planned'));
    await writeFile(join(root,'docs/roadmap/generated.md'),frontmatter('roadmap-01','roadmap'));
    await writeFile(join(root,'docs/merge-decisions.md'),frontmatter('plan-08-01-merge','governance-evidence','superseded'));
    await writeFile(join(root,'docs/unprefixed.md'),frontmatter('plan-91','plan','draft'));
    const run=spawnSync(process.execPath,[cli,'check',`--root=${root}`],{encoding:'utf8'});
    assert.equal(run.status,1);
    assert.equal(run.stderr,'');
    assert.match(run.stdout,/\[ERROR\] docs\/bad\.md/);
    assert.match(run.stdout,/\[WARNING\] docs\/unprefixed\.md\n {2}Filename does not start with numeric prefix/);
    assert.match(run.stdout,/Invalid Plan lifecycle status/);
    assert.doesNotMatch(run.stdout,/\[ERROR\] (README\.md|docs\/README\.md)/);
    assert.doesNotMatch(run.stdout,/\[WARNING\] docs\/roadmap\/generated\.md/);
    assert.doesNotMatch(run.stdout,/\[WARNING\] docs\/merge-decisions\.md/);
    assert.doesNotMatch(run.stdout,/\[WARNING\] docs\/0[12]-spec-/);
    await rm(join(root,'docs/bad.md')); await rm(join(root,'docs/unprefixed.md'));
    await rm(join(root,'docs/01-spec-one.md')); await rm(join(root,'docs/02-spec-two.md'));
    await rm(join(root,'docs/03-plan-one.md')); await rm(join(root,'docs/merge-decisions.md'));
    await rm(join(root,'docs/roadmap/generated.md'));
    const clean=spawnSync(process.execPath,[cli,'check',`--root=${root}`],{encoding:'utf8'});
    assert.equal(clean.status,0);
    assert.equal(clean.stdout,'All documentation files pass checks.\n');
  } finally { await rm(root,{recursive:true,force:true}); }
});
