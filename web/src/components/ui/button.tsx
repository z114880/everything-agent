import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { Children, isValidElement } from "react";
import type * as React from "react";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-transparent text-sm font-semibold shadow-sm outline-none transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:border-[var(--button-disabled-border)] disabled:bg-[var(--button-disabled)] disabled:text-[var(--button-disabled-foreground)] disabled:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground enabled:hover:bg-[var(--primary-hover)]",
        secondary: "border-border bg-secondary text-secondary-foreground enabled:hover:border-[var(--secondary-hover)] enabled:hover:bg-[var(--secondary-hover)]",
        outline: "border-input bg-card text-foreground enabled:hover:border-primary/35 enabled:hover:bg-accent enabled:hover:text-accent-foreground",
        ghost: "shadow-none enabled:hover:bg-accent enabled:hover:text-accent-foreground",
        destructive: "bg-destructive text-white enabled:hover:bg-[var(--destructive-hover)]",
        "destructive-outline": "border-destructive/35 bg-[var(--destructive-soft)] text-destructive shadow-none enabled:hover:border-destructive/55 enabled:hover:bg-[var(--destructive-soft-hover)]",
      },
      size: {
        default: "h-9 px-4",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 px-5",
        icon: "size-9 px-0",
        "icon-sm": "size-8 px-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

/** 统一按钮的视觉、禁用与异步加载语义。 */
function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  const childItems = Children.toArray(children);
  const hasLeadingIcon = isValidElement(childItems[0]);
  return (
    <Comp
      data-slot="button"
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled || loading}
      {...props}
    >
      <span className="relative inline-flex items-center gap-2">
        {hasLeadingIcon ? (
          <>
            <span className="relative inline-flex shrink-0 items-center justify-center">
              <span className={cn("contents", loading && "[&>svg]:invisible")}>
                {childItems[0]}
              </span>
              {loading && <LoaderCircle data-slot="button-loading-indicator" className="absolute size-4 animate-spin" aria-hidden="true" />}
            </span>
            {childItems.slice(1)}
          </>
        ) : (
          <>
            {loading && <LoaderCircle data-slot="button-loading-indicator" className="absolute -left-3 size-3 animate-spin" aria-hidden="true" />}
            {childItems}
          </>
        )}
      </span>
    </Comp>
  );
}

export { Button, buttonVariants, type ButtonProps };
