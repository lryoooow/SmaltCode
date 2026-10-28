import{it,expect}from'vitest';import{externalRuntimePath}from'../src/main/runtime-path';
it('maps packaged interpreter and worker files to their extracted paths, preserving source paths',()=>{
 for(const file of ['office-worker.ps1','libreoffice-worker.py','ssh-key-worker.cjs']){
  expect(externalRuntimePath('D:\\SmaltCode\\resources\\app.asar\\dist\\main\\'+file)).toBe('D:\\SmaltCode\\resources\\app.asar.unpacked\\dist\\main\\'+file);
  expect(externalRuntimePath('/opt/SmaltCode/resources/app.asar/dist/main/'+file)).toBe('/opt/SmaltCode/resources/app.asar.unpacked/dist/main/'+file);
  expect(externalRuntimePath('/repo/packages/desktop/dist/main/'+file)).toBe('/repo/packages/desktop/dist/main/'+file);
 }
 expect(externalRuntimePath('/repo/app.asar-backup/file.py')).toBe('/repo/app.asar-backup/file.py');
 expect(externalRuntimePath('/app.asar.unpacked/dist/main/file.py')).toBe('/app.asar.unpacked/dist/main/file.py');
});
