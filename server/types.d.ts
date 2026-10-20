declare module 'heic-convert' {
  export default function convert(opts: { buffer: Buffer | ArrayBuffer; format: 'JPEG' | 'PNG'; quality?: number }): Promise<ArrayBuffer>;
}
