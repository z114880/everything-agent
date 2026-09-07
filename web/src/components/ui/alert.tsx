import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils";

const alertVariants = cva("relative grid w-full grid-cols-[auto_1fr] items-start gap-x-3 rounded-lg border p-3.5 text-sm [&>svg]:mt-0.5 [&>svg]:size-4", {
  variants: {
    variant: {
      default: "border-border bg-muted/45 text-foreground",
      info: "border-primary/15 bg-primary/[0.055] text-foreground [&>svg]:text-primary",
      warning: "border-amber-200 bg-amber-50/70 text-amber-950 [&>svg]:text-amber-600",
      destructive: "border-red-200 bg-red-50/70 text-red-900 [&>svg]:text-red-600",
    },
  },
  defaultVariants: { variant: "default" },
});

function Alert({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div role="alert" data-slot="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}
function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("font-medium leading-none", className)} {...props} />;
}
function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("col-start-2 text-xs leading-relaxed text-current/75", className)} {...props} />;
}

export { Alert, AlertDescription, AlertTitle };
