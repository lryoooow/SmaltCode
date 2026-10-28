import { parentPort,workerData } from 'node:worker_threads';
import { utils } from 'ssh2';
try{const key=utils.parseKey(workerData.privateKey,workerData.passphrase);if(key instanceof Error||Array.isArray(key)||!key.isPrivateKey())throw Error();parentPort!.postMessage({key:key.getPrivatePEM().toString()});}catch{parentPort!.postMessage({error:'密钥或解密口令无效，请检查是否为支持的私钥'});}
