/** Stand-in for the Workers runtime module `cloudflare:email` under Vitest. */
export class EmailMessage {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly raw: ReadableStream | string,
  ) {}
}
