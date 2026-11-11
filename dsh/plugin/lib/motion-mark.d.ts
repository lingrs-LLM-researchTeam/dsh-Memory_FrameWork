export declare function useMotionPreference(): {
    enabled: boolean;
    reduced: boolean;
    change: (value: boolean) => void;
};
/** Fifteen small CSS transforms, two finite cycles; never a JS rendering loop. */
export declare function MotionMark({ enabled }: {
    enabled: boolean;
}): import("react/jsx-runtime").JSX.Element;
