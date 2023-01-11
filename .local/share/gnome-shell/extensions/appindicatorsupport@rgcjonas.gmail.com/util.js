// This file is part of the AppIndicator/KStatusNotifierItem GNOME Shell extension
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.

/* exported refreshPropertyOnProxy, getUniqueBusName, getBusNames,
   introspectBusObject, dbusNodeImplementsInterfaces, waitForStartupCompletion,
   connectSmart, disconnectSmart, versionCheck, getDefaultTheme,
   getProcessName, ensureProxyAsyncMethod, queueProxyPropertyUpdate,
   getProxyProperty, indicatorId, tryCleanupOldIndicators */

const ByteArray = imports.byteArray;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Gdk = imports.gi.Gdk;
const Main = imports.ui.main;
const Meta = imports.gi.Meta;
const GObject = imports.gi.GObject;
const St = imports.gi.St;

const Config = imports.misc.config;
const ExtensionUtils = imports.misc.extensionUtils;
const Extension = ExtensionUtils.getCurrentExtension();
const IndicatorStatusIcon = Extension.imports.indicatorStatusIcon;
const Params = imports.misc.params;
const PromiseUtils = Extension.imports.promiseUtils;
const Signals = imports.signals;

var BUS_ADDRESS_REGEX = /([a-zA-Z0-9._-]+\.[a-zA-Z0-9.-]+)|(:[0-9]+\.[0-9]+)$/;

PromiseUtils._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');
PromiseUtils._promisify(Gio._LocalFilePrototype, 'read', 'read_finish');
PromiseUtils._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');

function indicatorId(service, busName, objectPath) {
    if (service && service !== busName && service.match(BUS_ADDRESS_REGEX))
        return service;

    return `${busName}@${objectPath}`;
}

function getProxyProperty(proxy, propertyName, cancellable) {
    return proxy.g_connection.call(proxy.g_name,
        proxy.g_object_path, 'org.freedesktop.DBus.Properties', 'Get',
        GLib.Variant.new('(ss)', [proxy.g_interface_name, propertyName]),
        GLib.VariantType.new('(v)'), Gio.DBusCallFlags.NONE, -1,
        cancellable);
}

async function refreshPropertyOnProxy(proxy, propertyName, params) {
    params = Params.parse(params, {
        skipEqualityCheck: false,
    });

    const cancellable = cancelRefreshPropertyOnProxy(proxy, {
        propertyName,
        addNew: true,
    });

    try {
        const [valueVariant] = (await getProxyProperty(
            proxy, propertyName, cancellable)).deep_unpack();

        proxy._proxyCancellables.delete(propertyName);
        await queueProxyPropertyUpdate(proxy, propertyName, valueVariant,
            { ...params, cancellable });
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
            // the property may not even exist, silently ignore it
            Logger.debug(`While refreshing property ${propertyName}: ${e}`);
            proxy.set_cached_property(propertyName, null);
            proxy._proxyCancellables.delete(propertyName);
            if (proxy._proxyChangedProperties)
                delete proxy._proxyChangedProperties[propertyName];
            throw e;
        }
    }
}

async function queueProxyPropertyUpdate(proxy, propertyName, value, params) {
    params = Params.parse(params, {
        skipEqualityCheck: false,
        cancellable: null,
    });

    if (!params.skipEqualityCheck &&
        value.equal(proxy.get_cached_property(propertyName)))
        return;

    proxy.set_cached_property(propertyName, value);

    // synthesize a batched property changed event
    if (!proxy._proxyChangedProperties)
        proxy._proxyChangedProperties = {};
    proxy._proxyChangedProperties[propertyName] = value;

    if (!proxy._proxyPropertiesEmit || !proxy._proxyPropertiesEmit.pending()) {
        if (!params.cancellable) {
            params.cancellable = cancelRefreshPropertyOnProxy(proxy, {
                propertyName,
                addNew: true,
            });
        }
        proxy._proxyPropertiesEmit = new PromiseUtils.TimeoutPromise(16,
            GLib.PRIORITY_DEFAULT_IDLE, params.cancellable);
        await proxy._proxyPropertiesEmit;
        proxy.emit('g-properties-changed', GLib.Variant.new('a{sv}',
            proxy._proxyChangedProperties), []);
        delete proxy._proxyChangedProperties;
    }
}

function cancelRefreshPropertyOnProxy(proxy, params) {
    params = Params.parse(params, {
        propertyName: undefined,
        addNew: false,
    });

    if (!proxy._proxyCancellables) {
        if (!params.addNew)
            return null;

        proxy._proxyCancellables = new Map();
    }

    if (params.propertyName !== undefined) {
        let cancellable = proxy._proxyCancellables.get(params.propertyName);
        if (cancellable) {
            cancellable.cancel();

            if (!params.addNew)
                proxy._proxyCancellables.delete(params.propertyName);
        }

        if (params.addNew) {
            cancellable = new Gio.Cancellable();
            proxy._proxyCancellables.set(params.propertyName, cancellable);
            return cancellable;
        }
    } else {
        proxy._proxyCancellables.forEach(c => c.cancel());
        delete proxy._proxyChangedProperties;
        delete proxy._proxyCancellables;
    }

    return null;
}

async function getUniqueBusName(bus, name, cancellable) {
    if (name[0] === ':')
        return name;

    if (!bus)
        bus = Gio.DBus.session;

    const variantName = new GLib.Variant('(s)', [name]);
    const [unique] = (await bus.call('org.freedesktop.DBus', '/', 'org.freedesktop.DBus',
        'GetNameOwner', variantName, new GLib.VariantType('(s)'),
        Gio.DBusCallFlags.NONE, -1, cancellable)).deep_unpack();

    return unique;
}

async function getBusNames(bus, cancellable) {
    if (!bus)
        bus = Gio.DBus.session;

    const [names] = (await bus.call('org.freedesktop.DBus', '/', 'org.freedesktop.DBus',
        'ListNames', null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE,
        -1, cancellable)).deep_unpack();

    const uniqueNames = new Map();
    const requests = names.map(name => getUniqueBusName(bus, name, cancellable));
    const results = await Promise.allSettled(requests);

    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
            let namesForBus = uniqueNames.get(result.value);
            if (!namesForBus) {
                namesForBus = new Set();
                uniqueNames.set(result.value, namesForBus);
            }
            namesForBus.add(result.value !== names[i] ? names[i] : null);
        } else if (!result.reason.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
            Logger.debug(`Impossible to get the unique name of ${names[i]}: ${result.reason}`);
        }
    }

    return uniqueNames;
}

async function getProcessId(connectionName, cancellable = null, bus = Gio.DBus.session) {
    const res = await bus.call('org.freedesktop.DBus', '/',
        'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
        new GLib.Variant('(s)', [connectionName]),
        new GLib.VariantType('(u)'),
        Gio.DBusCallFlags.NONE,
        -1,
        cancellable);
    const [pid] = res.deepUnpack();
    return pid;
}

// This can be removed when we will have GNOME 43 as minimum version
function ensureProxyAsyncMethod(proxy, method) {
    if (proxy[`${method}Async`])
        return;

    if (!proxy[`${method}Remote`])
        throw new Error(`Missing remote method '${method}'`);

    proxy[`${method}Async`] = function (...args) {
        return new Promise((resolve, reject) => {
            this[`${method}Remote`](...args, (ret, e) => {
                if (e)
                    reject(e);
                else
                    resolve(ret);
            });
        });
    };
}

async function getProcessName(connectionName, cancellable = null,
    priority = GLib.PRIORITY_DEFAULT, bus = Gio.DBus.session) {
    const pid = await getProcessId(connectionName, cancellable, bus);
    const cmdFile = Gio.File.new_for_path(`/proc/${pid}/cmdline`);
    const inputStream = await cmdFile.read_async(priority, cancellable);
    const bytes = await inputStream.read_bytes_async(2048, priority, cancellable);
    return ByteArray.toString(bytes.toArray().map(v => !v ? 0x20 : v));
}

async function introspectBusObject(bus, name, cancellable, path = undefined) {
    if (!path)
        path = '/';

    const [introspection] = (await bus.call(name, path, 'org.freedesktop.DBus.Introspectable',
        'Introspect', null, new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE,
        -1, cancellable)).deep_unpack();

    const nodeInfo = Gio.DBusNodeInfo.new_for_xml(introspection);
    const nodes = [{ nodeInfo, path }];

    if (path === '/')
        path = '';

    const requests = [];
    for (const subNodes of nodeInfo.nodes) {
        const subPath = `${path}/${subNodes.path}`;
        requests.push(introspectBusObject(bus, name, cancellable, subPath));
    }

    for (const result of await Promise.allSettled(requests)) {
        if (result.status === 'fulfilled')
            result.value.forEach(n => nodes.push(n));
        else if (!result.reason.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            Logger.debug(`Impossible to get node info: ${result.reason}`);
    }

    return nodes;
}

function dbusNodeImplementsInterfaces(nodeInfo, interfaces) {
    if (!(nodeInfo instanceof Gio.DBusNodeInfo) || !Array.isArray(interfaces))
        return false;

    return interfaces.some(iface => nodeInfo.lookup_interface(iface));
}

var NameWatcher = class AppIndicatorsNameWatcher {
    constructor(name) {
        this._watcherId = Gio.DBus.session.watch_name(name,
            Gio.BusNameWatcherFlags.NONE, () => {
                this._nameOnBus = true;
                Logger.debug(`Name ${name} appeared`);
                this.emit('changed');
                this.emit('appeared');
            }, () => {
                this._nameOnBus = false;
                Logger.debug(`Name ${name} vanished`);
                this.emit('changed');
                this.emit('vanished');
            });
    }

    destroy() {
        this.emit('destroy');

        Gio.DBus.session.unwatch_name(this._watcherId);
        delete this._watcherId;
    }

    get nameOnBus() {
        return !!this._nameOnBus;
    }
};
Signals.addSignalMethods(NameWatcher.prototype);

function connectSmart3A(src, signal, handler) {
    let id = src.connect(signal, handler);
    let destroyId = 0;

    if (src.connect && (!(src instanceof GObject.Object) || GObject.signal_lookup('destroy', src))) {
        destroyId = src.connect('destroy', () => {
            src.disconnect(id);
            src.disconnect(destroyId);
        });
    }

    return [id, destroyId];
}

function connectSmart4A(src, signal, target, method) {
    if (typeof method !== 'function')
        throw new TypeError('Unsupported function');

    method = method.bind(target);
    const signalId = src.connect(signal, method);
    const onDestroy = () => {
        src.disconnect(signalId);
        if (srcDestroyId)
            src.disconnect(srcDestroyId);
        if (tgtDestroyId)
            target.disconnect(tgtDestroyId);
    };

    // GObject classes might or might not have a destroy signal
    // JS Classes will not complain when connecting to non-existent signals
    const srcDestroyId = src.connect && (!(src instanceof GObject.Object) ||
        GObject.signal_lookup('destroy', src)) ? src.connect('destroy', onDestroy) : 0;
    const tgtDestroyId = target.connect && (!(target instanceof GObject.Object) ||
        GObject.signal_lookup('destroy', target)) ? target.connect('destroy', onDestroy) : 0;

    return [signalId, srcDestroyId, tgtDestroyId];
}

// eslint-disable-next-line valid-jsdoc
/**
 * Connect signals to slots, and remove the connection when either source or
 * target are destroyed
 *
 * Usage:
 *      Util.connectSmart(srcOb, 'signal', tgtObj, 'handler')
 * or
 *      Util.connectSmart(srcOb, 'signal', () => { ... })
 */
function connectSmart(...args) {
    if (arguments.length === 4)
        return connectSmart4A(...args);
    else
        return connectSmart3A(...args);
}

function disconnectSmart3A(src, signalIds) {
    const [id, destroyId] = signalIds;
    src.disconnect(id);

    if (destroyId)
        src.disconnect(destroyId);
}

function disconnectSmart4A(src, tgt, signalIds) {
    const [signalId, srcDestroyId, tgtDestroyId] = signalIds;

    disconnectSmart3A(src, [signalId, srcDestroyId]);

    if (tgtDestroyId)
        tgt.disconnect(tgtDestroyId);
}

function disconnectSmart(...args) {
    if (arguments.length === 2)
        return disconnectSmart3A(...args);
    else if (arguments.length === 3)
        return disconnectSmart4A(...args);

    throw new TypeError('Unexpected number of arguments');
}

function getDefaultTheme() {
    if (Gdk.Screen.get_default()) {
        const defaultTheme = Gtk.IconTheme.get_default();
        if (defaultTheme)
            return defaultTheme;
    }

    const defaultTheme = new Gtk.IconTheme();
    defaultTheme.set_custom_theme(St.Settings.get().gtk_icon_theme);
    return defaultTheme;
}

// eslint-disable-next-line valid-jsdoc
/**
 * Helper function to wait for the system startup to be completed.
 * Adding widgets before the desktop is ready to accept them can result in errors.
 */
async function waitForStartupCompletion(cancellable) {
    if (Main.layoutManager._startingUp)
        await Main.layoutManager.connect_once('startup-complete', cancellable);

    const displayManager = Gdk.DisplayManager.get();
    if (!Meta.is_wayland_compositor() && !displayManager.get_default_display())
        await displayManager.connect_once('display-opened', cancellable);
}

/**
 * Helper class for logging stuff
 */
var Logger = class AppIndicatorsLogger {
    static _logStructured(logLevel, message, extraFields = {}) {
        if (!Object.values(GLib.LogLevelFlags).includes(logLevel)) {
            Logger._logStructured(GLib.LogLevelFlags.LEVEL_WARNING,
                'logLevel is not a valid GLib.LogLevelFlags');
            return;
        }

        Logger._init(Extension.metadata.name);
        if (!Logger._levels.includes(logLevel))
            return;

        let fields = {
            'SYSLOG_IDENTIFIER': Extension.metadata.uuid,
            'MESSAGE': `${message}`,
        };

        let thisFile = null;
        let { stack } = new Error();
        for (let stackLine of stack.split('\n')) {
            stackLine = stackLine.replace('resource:///org/gnome/Shell/', '');
            let [code, line] = stackLine.split(':');
            let [func, file] = code.split(/@(.+)/);

            if (!thisFile || thisFile === file) {
                thisFile = file;
                continue;
            }

            fields = Object.assign(fields, {
                'CODE_FILE': file || '',
                'CODE_LINE': line || '',
                'CODE_FUNC': func || '',
            });

            break;
        }

        GLib.log_structured(Logger._domain, logLevel, Object.assign(fields, extraFields));
    }

    static _init(domain) {
        if (Logger._domain)
            return;

        const allLevels = Object.values(GLib.LogLevelFlags);
        const domains = GLib.getenv('G_MESSAGES_DEBUG');
        Logger._domain = domain.replaceAll(' ', '-');

        if (domains === 'all' || (domains && domains.split(' ').includes(Logger._domain))) {
            Logger._levels = allLevels;
        } else {
            Logger._levels = allLevels.filter(
                l => l <= GLib.LogLevelFlags.LEVEL_WARNING);
        }
    }

    static debug(message) {
        Logger._logStructured(GLib.LogLevelFlags.LEVEL_DEBUG, message);
    }

    static message(message) {
        Logger._logStructured(GLib.LogLevelFlags.LEVEL_MESSAGE, message);
    }

    static warn(message) {
        Logger._logStructured(GLib.LogLevelFlags.LEVEL_WARNING, message);
    }

    static error(message) {
        Logger._logStructured(GLib.LogLevelFlags.LEVEL_ERROR, message);
    }

    static critical(message) {
        Logger._logStructured(GLib.LogLevelFlags.LEVEL_CRITICAL, message);
    }
};

function versionCheck(required) {
    if (ExtensionUtils.versionCheck instanceof Function)
        return ExtensionUtils.versionCheck(required, Config.PACKAGE_VERSION);

    const current = Config.PACKAGE_VERSION;
    let currentArray = current.split('.');
    let major = currentArray[0];
    let minor = currentArray[1];
    for (let i = 0; i < required.length; i++) {
        let requiredArray = required[i].split('.');
        if (requiredArray[0] === major &&
            (requiredArray[1] === undefined && isFinite(minor) ||
                requiredArray[1] === minor))
            return true;
    }
    return false;
}

function tryCleanupOldIndicators() {
    const indicatorType = IndicatorStatusIcon.BaseStatusIcon;
    const indicators = Object.values(Main.panel.statusArea).filter(i => i instanceof indicatorType);

    try {
        const panelBoxes = [
            Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox,
        ];

        panelBoxes.forEach(box =>
            indicators.push(...box.get_children().filter(i => i instanceof indicatorType)));
    } catch (e) {
        logError(e);
    }

    new Set(indicators).forEach(i => i.destroy());
}
