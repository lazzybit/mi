// A bound reference to the global fetch. In workerd, `fetch` is a method of the
// global object and must be called with that receiver; storing it and calling it
// as an object method throws "Illegal invocation". Binding once keeps injected
// transports and real network calls working in both workerd and Node.
export const globalFetch: typeof fetch = fetch.bind(globalThis);
