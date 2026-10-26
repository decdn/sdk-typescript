// Global setup of the browser smoke run: a public fake gateway on
// `decdn.localhost:<port>` (Chromium resolves it and every site host under it to
// loopback), named to the tests through `provide`.
import type { TestProject } from "vitest/node";
import { FakeGateway } from "../fake-gateway.js";

export interface BrowserGateway {
  url: string;
  bundle: string;
  blob: string;
  blobText: string;
  tampered: string;
  data: number[];
}

declare module "vitest" {
  export interface ProvidedContext {
    gateway: BrowserGateway;
  }
}

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const gw = new FakeGateway({ mode: "public", host: "decdn.localhost" });
  const blobText = "bytes a browser hashes as they stream\n";
  const blob = gw.addBlob(blobText);
  const tampered = gw.addBlob("bytes the gateway alters\n");
  gw.tampered.add(tampered);
  const data = Array.from({ length: 4096 }, (_, i) => (i * 7) & 0xff);
  const bundle = gw.addBundle({
    "data.bin": new Uint8Array(data),
    "a.txt": "abc",
  });
  const listener = await gw.listen();
  gw.host = `decdn.localhost:${listener.address.split(":")[1]}`;
  project.provide("gateway", {
    url: gw.url,
    bundle: bundle.hash,
    blob,
    blobText,
    tampered,
    data,
  });
  return listener.close;
}
