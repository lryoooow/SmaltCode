import { validateInput } from '@smalt/kernel';
const integer=(minimum:number,maximum:number)=>({type:'integer',minimum,maximum});
const row=integer(0,1048575),column=integer(0,16383),sheet=integer(0,255),text={type:'string',maxLength:4000};
const object=(properties:Record<string,unknown>,required:string[])=>({type:'object',properties,required,additionalProperties:false});
const range=object({row,column,rows:integer(1,2000),columns:integer(1,2000)},['row','column','rows','columns']);
const cell=object({kind:{type:'string',enum:['text','number','boolean','formula']},value:{type:['string','number','boolean'],maxLength:4000}},['kind','value']);
const operations:Record<string,Record<string,unknown>>={
 'set-cell':{range,cell},paste:{range,values:{type:'array',maxItems:200,items:{type:'array',maxItems:100,items:cell}}},copy:{range,destination:object({sheet,row,column},['sheet','row','column'])},
 'insert-rows':{index:row,count:integer(1,200)},'delete-rows':{index:row,count:integer(1,200)},'insert-columns':{index:column,count:integer(1,100)},'delete-columns':{index:column,count:integer(1,100)},
 'sheet-add':{name:{type:'string',minLength:1,maxLength:31},index:sheet},'sheet-delete':{},'sheet-rename':{name:{type:'string',minLength:1,maxLength:31}},
 format:{range,style:object({bold:{type:'boolean'},italic:{type:'boolean'},wrap:{type:'boolean'},align:{type:'string',enum:['left','center','right']},numberFormat:{type:'string',enum:['general','integer','decimal','percent','date','thousands']},color:integer(0,0xffffff),background:integer(0,0xffffff)},[])},
 sort:{range,field:integer(0,1999),ascending:{type:'boolean'},header:{type:'boolean'}},filter:{range,field:integer(0,1999),header:{type:'boolean'},filter:object({operator:{type:'string',enum:['equals','greater','less']},value:{type:['string','number'],maxLength:1000}},['operator','value'])},'clear-filter':{range},merge:{range,merge:{type:'boolean'}},
};
const required:Record<string,string[]>={'set-cell':['range','cell'],paste:['range','values'],copy:['range','destination'],'insert-rows':['index','count'],'delete-rows':['index','count'],'insert-columns':['index','count'],'delete-columns':['index','count'],'sheet-add':['name','index'],'sheet-delete':[],'sheet-rename':['name'],format:['range','style'],sort:['range','field','ascending','header'],filter:['range','field','header','filter'],'clear-filter':['range'],merge:['range','merge']};
const functions=new Set('SUM AVERAGE MIN MAX COUNT COUNTA IF IFERROR ROUND ROUNDUP ROUNDDOWN ABS INT MOD AND OR NOT LEN LEFT RIGHT MID CONCAT CONCATENATE TEXT VALUE DATE YEAR MONTH DAY TODAY NOW VLOOKUP HLOOKUP XLOOKUP INDEX MATCH COUNTIF COUNTIFS SUMIF SUMIFS PRODUCT SUMPRODUCT SQRT POWER TRIM UPPER LOWER ISNUMBER ISTEXT ISBLANK TRUE FALSE'.split(' '));
export function calcFormula(value:string){if(!value.startsWith('=')||value.length>4000||/[\x00-\x1f\[\]{}\\]|(?:https?|file|ftp):|\|/i.test(value))throw Error('公式包含不支持的外部引用或内容');const stripped=value.replace(/"(?:[^"]|"")*"/g,'""');for(const match of stripped.matchAll(/([A-Z_][A-Z0-9_.]*)\s*\(/gi))if(!functions.has(match[1]!.toUpperCase()))throw Error('本轮尚未支持该公式函数：'+match[1]);}
export function calcRequest(action:'view'|'edit',value:unknown):Record<string,any>{
 if(!value||typeof value!=='object'||JSON.stringify(value).length>32768)throw Error('表格请求无效或超过 32K 字符');
 const v=value as any,properties=action==='view'?{sheet,row,column,rows:integer(1,20),columns:integer(1,10)}:{token:{type:'string',minLength:48,maxLength:48},sheet,operation:{type:'string',enum:Object.keys(operations)},...(operations[v.operation]??{})};
 const result=validateInput(object(properties,action==='view'?['sheet','row','column','rows','columns']:['token','sheet','operation',...(required[v.operation]??[])]),value);if(!result.ok)throw Error('表格操作参数无效：'+result.error);
 if(action==='view'){if(v.row+v.rows>1048576||v.column+v.columns>16384)throw Error('表格分页超出行列范围');return result.value;}
 if(!/^[a-f0-9]{48}$/.test(v.token))throw Error('表格快照令牌无效');if(v.range&&(v.range.rows*v.range.columns>2000||v.range.row+v.range.rows>1048576||v.range.column+v.range.columns>16384))throw Error('操作范围最多 2000 个单元格且不能越界');
 if(v.operation==='set-cell'&&v.range.rows*v.range.columns!==1)throw Error('单元格编辑仅接受一个位置');
 const cells=v.cell?[v.cell]:v.values?.flat()??[];for(const c of cells){if(c.kind==='formula'){if(typeof c.value!=='string')throw Error('公式必须为文字');calcFormula(c.value);}else if(typeof c.value!==({text:'string',number:'number',boolean:'boolean'}as any)[c.kind])throw Error('单元格类型与值不一致');}
 if(v.values&&(v.values.length!==v.range.rows||v.values.some((r:any[])=>r.length!==v.range.columns)||cells.reduce((n:number,c:any)=>n+String(c.value).length,0)>8000))throw Error('粘贴范围与矩阵不一致或内容超过 8000 字符');
 if(v.name&&/[\\/*?:\[\]\x00-\x1f]/.test(v.name))throw Error('工作表名称包含无效字符');
 if(v.destination&&(v.destination.row+v.range.rows>1048576||v.destination.column+v.range.columns>16384))throw Error('复制目标超出行列范围');
 if(v.field!==undefined&&v.field>=v.range.columns)throw Error('排序或筛选列不属于选择范围');
 return result.value;
}
