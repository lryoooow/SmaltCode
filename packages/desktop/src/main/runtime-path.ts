/** External interpreters and Node workers need an actual filesystem path. */
export function externalRuntimePath(file:string){
  return file.replace(/([\\/])app\.asar([\\/]|$)/i,'$1app.asar.unpacked$2');
}
