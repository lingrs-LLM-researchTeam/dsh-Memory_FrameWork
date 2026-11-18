import { z } from "zod";
export declare const JournalRow: z.ZodObject<{
    sessionId: z.ZodString;
    messageId: z.ZodString;
    message: z.ZodOptional<z.ZodJSONSchema>;
    admitted: z.ZodBoolean;
}, z.core.$strict>;
export declare function compactConfirmedJournal(path: string, confirmed: readonly {
    sessionId: string;
    messageId: string;
}[]): void;
