import type { Call } from "./contracts.js";
export declare function Dashboard({ call, initialSessionId, onHandoff, }: {
    call: Call;
    initialSessionId?: string;
    onHandoff?: (id: string) => Promise<void>;
}): import("react/jsx-runtime").JSX.Element;
