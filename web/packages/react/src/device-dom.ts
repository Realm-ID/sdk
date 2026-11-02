/**
 * Installs the jsdom globals. Imported FIRST by device-test-harness.tsx: react-dom decides at import time
 * whether the DOM supports `input` events, so the globals must exist before it loads or onChange on a text
 * input never fires under test.
 */
import { JSDOM } from "jsdom";

export const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://app.test/device?code=ABCD-EFGH" });
const g = globalThis as any;
g.window = dom.window; g.document = dom.window.document;
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node; g.Event = dom.window.Event;
g.IS_REACT_ACT_ENVIRONMENT = true;
