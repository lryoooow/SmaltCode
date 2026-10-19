export type DocumentFormat = 'text' | 'image' | 'pdf' | 'docx' | 'xlsx';
export type DocumentContent = {
  format: DocumentFormat;
  text: string;
  warnings: string[];
  truncated?: boolean;
  pages?: string[];
  sheets?: Array<{ name: string; rows: string[][] }>;
  paragraphs?: Array<{ text: string; heading: boolean }>;
  mimeType?: 'image/png' | 'image/jpeg';
};
export type DocumentPreview = DocumentContent & { binary: boolean; size: number; digest: string; dataUrl?: string; reason?: string };
export type Attachment = { id: string; name: string; size: number; format: DocumentFormat; digest: string };
