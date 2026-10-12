/**
 * The slice of the V2 plugin context `RunManager` actually needs.
 *
 * Declared structurally rather than as `Context["session"]` because the V2 package
 * only re-exports `Plugin` from its root entrypoint, and the deep subpath that
 * carries the `Context` type (`@opencode/plugin/plugin`) is not mapped by the
 * package's `exports` map. `ctx.session` satisfies this shape, and keeping the
 * dependency narrow is what lets the repro scripts drive the manager with a
 * two-method stub instead of a live server.
 */
export type SessionClient = {
    get(input: { sessionID: string }): Promise<{ parentID?: string }>;
    synthetic(input: {
        sessionID: string;
        text: string;
        description?: string;
        resume?: boolean;
    }): Promise<unknown>;
};