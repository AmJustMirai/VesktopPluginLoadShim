/*
 * @vesktop-sideload-shim
 *
 * Sideload proxy for Vesktop's Vencord files. Install in Vesktop's own vencordFiles folder:
 *
 *   vencordDesktopMain.js        -> rename to orig-vencordDesktopMain.js
 *   (this file)                  -> save as vencordDesktopMain.js
 *   userplugins/*.js             -> renderer plugins
 *   userplugins/*.native.js      -> main-process halves, exposed as VencordNative.pluginHelpers.<Name>
 *
 * Every other file stays as Vesktop downloaded it. This file:
 *   1. redirects writes aimed at vencordDesktopMain.js to orig-vencordDesktopMain.js, so Vencord's
 *      updater and Vesktop's "Force Update" / "Repair" update the real file and leave this one alone
 *   2. wraps Vesktop's IPC handler that serves the Vencord renderer and appends the prelude and the
 *      plugins to it before it reaches the page (the file on disk is never modified)
 *   3. loads orig-vencordDesktopMain.js
 *   4. registers the native halves of user plugins
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");
const { ipcMain } = require("electron");

const DIR = __dirname;
const SELF = path.join(DIR, "vencordDesktopMain.js");
const ORIG = path.join(DIR, "orig-vencordDesktopMain.js");
const PLUGINS_DIR = path.join(DIR, "userplugins");

// Vesktop: src/shared/IpcEvents.ts -> GET_VENCORD_RENDERER_SCRIPT
const RENDERER_IPC = "VCD_GET_VC_RENDERER_SCRIPT";

const log = (...a) => console.log("[sideload]", ...a);

if (!fs.existsSync(ORIG))
    throw new Error(`[sideload] ${ORIG} is missing. Rename Vencord's original vencordDesktopMain.js to orig-vencordDesktopMain.js.`);

// Keep updates from overwriting this file
function redirect(file) {
    try {
        const p = file instanceof URL ? fileURLToPath(file) : file;
        if (typeof p === "string" && path.resolve(p) === SELF) {
            log("redirecting update of vencordDesktopMain.js ->", path.basename(ORIG));
            return ORIG;
        }
    } catch { }
    return file;
}

function wrapWrite(obj, key) {
    const original = obj[key];
    if (typeof original !== "function") return;
    obj[key] = function (file, ...rest) {
        return original.call(this, redirect(file), ...rest);
    };
}

// Vencord's updater: (0, require("fs/promises").writeFile)(...)
// Vesktop's downloader: (0, require("fs").createWriteStream)(...)
wrapWrite(fs.promises, "writeFile");
wrapWrite(fs, "writeFile");
wrapWrite(fs, "writeFileSync");
wrapWrite(fs, "createWriteStream");

// Append the prelude and user plugins to the renderer Vesktop serves
// Runs in Discord's page right after stock Vencord, before Discord's own code.
// Does for one late plugin what Vencord's initPluginManager() does for built-in ones.
function prelude() {
    const PM = Vencord.Plugins;
    const { Settings, SettingsStore, definePluginSettings } = Vencord.Api.Settings;

    // Vencord's const enums are inlined at build time, so mirror their values here.
    const OptionType = { STRING: 0, NUMBER: 1, BIGINT: 2, BOOLEAN: 3, SELECT: 4, SLIDER: 5, COMPONENT: 6, CUSTOM: 7 };
    const StartAt = { Init: "Init", DOMContentLoaded: "DOMContentLoaded", WebpackReady: "WebpackReady" };

    const BIND_KEYS = [
        "onBeforeMessageEdit", "onBeforeMessageSend", "onMessageClick",
        "renderMemberListDecorator", "renderMessageAccessory", "renderMessageDecoration"
    ];
    const NEEDED_APIS = [
        [p => p.commands?.length, "CommandsAPI"],
        [p => p.onBeforeMessageEdit || p.onBeforeMessageSend || p.onMessageClick, "MessageEventsAPI"],
        [p => p.chatBarButton, "ChatInputButtonAPI"],
        [p => p.renderMemberListDecorator, "MemberListDecoratorsAPI"],
        [p => p.renderMessageAccessory, "MessageAccessoriesAPI"],
        [p => p.renderMessageDecoration, "MessageDecorationsAPI"],
        [p => p.messagePopoverButton, "MessagePopoverAPI"],
        [p => p.userProfileBadge, "BadgeAPI"]
    ];

    function registerUserPlugin(p) {
        if (!p?.name) throw new Error("registerUserPlugin: plugin needs a name");
        if (PM.plugins[p.name]) throw new Error(`registerUserPlugin: a plugin named ${p.name} already exists`);

        // The settings modal looks up PluginMeta[name] and throws if it's missing. The main-process
        // renderer wrapper exposes that map as window.VencordPluginMeta.
        if (window.VencordPluginMeta) window.VencordPluginMeta[p.name] = { folderName: `userplugins/${p.name}`, userPlugin: true };

        p.description ??= "";
        p.authors ??= [{ name: "Unknown", id: 0n }];
        PM.plugins[p.name] = p; // visible to settings defaults, the plugin list and later start stages

        if (p.settings) {
            p.settings.pluginName = p.name;
            for (const [key, def] of Object.entries(p.settings.def))
                if (def.onChange) SettingsStore.addChangeListener(`plugins.${p.name}.${key}`, def.onChange);
        }

        if (!PM.isPluginEnabled(p.name)) return p;

        const deps = [...(p.dependencies ?? []), ...NEEDED_APIS.filter(([needs]) => needs(p)).map(([, api]) => api)];
        for (const dep of deps) {
            if (!PM.plugins[dep]) { console.warn(`[sideload] ${p.name}: unknown dependency ${dep}`); continue; }
            if (!PM.isPluginEnabled(dep)) {
                // Its patches were collected before we ran, so it only works from the next launch.
                Settings.plugins[dep].enabled = true;
                console.warn(`[sideload] ${p.name} enabled ${dep}; restart Vesktop once for it to take effect`);
            }
            PM.plugins[dep].isDependency = true;
        }

        for (const key of BIND_KEYS) if (p[key]) p[key] = p[key].bind(p);

        // Exported by Vencord; canonicalizes find/match and resolves $self to Vencord.Plugins.plugins[name]
        for (const patch of p.patches ?? []) PM.addPatch(patch, p.name);

        // Init has already run; DOMContentLoaded and WebpackReady haven't and will start us normally.
        if (p.startAt === StartAt.Init) PM.startPlugin(p);
        return p;
    }

    window.VencordShim = { registerUserPlugin, definePluginSettings, OptionType, StartAt };
}

function buildAddon() {
    const parts = [`\n;(${prelude.toString()})();\n`];
    let files = [];
    try {
        files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith(".js") && !f.endsWith(".native.js")).sort();
    } catch { }

    for (const f of files) {
        let src;
        try { src = fs.readFileSync(path.join(PLUGINS_DIR, f), "utf8"); } catch (e) { log("could not read", f, e); continue; }
        // Each plugin is isolated so one broken file can't take Vencord down with it.
        parts.push(`\n;(() => { try {\n${src}\n} catch (e) { console.error(${JSON.stringify(`[sideload] ${f} failed:`)}, e); } })();\n`);
    }
    return { code: parts.join(""), files };
}

// Only the last sourceURL / sourceMappingURL comment in a script counts; keep Vencord's last.
const keepSourceMaps = renderer => (renderer.match(/^\/\/# source(?:Mapping)?URL=.*$/gm) ?? []).join("\n");

const vesktopHandlers = ipcMain.listeners(RENDERER_IPC);
if (!vesktopHandlers.length) {
    log(`Vesktop has no "${RENDERER_IPC}" handler anymore; loading vanilla Vencord without user plugins.`);
} else {
    ipcMain.removeAllListeners(RENDERER_IPC);
    ipcMain.on(RENDERER_IPC, (event, ...args) => {
        // Let Vesktop's own handler validate the sender and read the stock renderer, but catch what it
        // returns (setting event.returnValue sends the sync reply immediately, so it must not reach the real event).
        let stock;
        const captured = new Proxy(event, {
            get: (t, k) => Reflect.get(t, k),
            set: (t, k, v) => (k === "returnValue" ? ((stock = v), true) : Reflect.set(t, k, v))
        });
        for (const h of vesktopHandlers) h(captured, ...args);

        if (typeof stock !== "string") {
            event.returnValue = stock;
            return;
        }

        try {
            const { code, files } = buildAddon();
            log(`serving renderer with ${files.length} user plugin(s):`, files.join(", ") || "(none)");
            // The bundle's PluginMeta is module-private; expose it so registerUserPlugin can add entries.
            const exposed = stock.replace(/([\w$]+)=(\{\[[\w$]+\.name\]:\{folderName:"_api\/badges")/, "$1=window.VencordPluginMeta=$2");
            if (exposed === stock) log("could not find PluginMeta in renderer; settings may crash for user plugins");
            event.returnValue = exposed + code + "\n" + keepSourceMaps(stock);
        } catch (e) {
            console.error("[sideload] failed to build user plugins, serving stock renderer:", e);
            event.returnValue = stock;
        }
    });
}

// Load the real Vencord main (its __dirname is this folder, so it behaves as stock)
module.exports = require(ORIG);

// Native (main process) halves of user plugins: userplugins/<Name>.native.js
// Exports become VencordNative.pluginHelpers.<Name>.*, same as Vencord's native.ts files.
const MAP_IPC = "VencordGetPluginIpcMethodMap";
const nativeMap = {};
try {
    for (const f of fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith(".native.js"))) {
        const name = f.slice(0, -".native.js".length);
        try {
            const methods = nativeMap[name] = {};
            for (const [method, fn] of Object.entries(require(path.join(PLUGINS_DIR, f)))) {
                const key = `VencordPluginNative_${name}_${method}`;
                ipcMain.handle(key, fn);
                methods[method] = key;
            }
        } catch (e) { delete nativeMap[name]; console.error("[sideload]", f, "failed:", e); }
    }
} catch { }

const mapHandlers = ipcMain.listeners(MAP_IPC);
ipcMain.removeAllListeners(MAP_IPC);
ipcMain.on(MAP_IPC, (event, ...args) => {
    let stock = {};
    const captured = new Proxy(event, {
        get: (t, k) => Reflect.get(t, k),
        set: (t, k, v) => (k === "returnValue" ? ((stock = v), true) : Reflect.set(t, k, v))
    });
    for (const h of mapHandlers) h(captured, ...args);
    event.returnValue = { ...stock, ...nativeMap };
});
