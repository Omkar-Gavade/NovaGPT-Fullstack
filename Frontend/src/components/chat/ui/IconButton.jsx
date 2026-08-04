import { forwardRef } from "react";

/**
 * Reusable icon button for the chat surface. Token-driven (no hardcoded colour),
 * accessible (requires `label`), with an optional hover tooltip.
 *
 * variant: "ghost" (default) | "solid" | "danger"
 * size:    "sm" (32px) | "md" (36px)
 */
const SIZE = { sm: "h-8 w-8", md: "h-9 w-9" };
const VARIANT = {
  ghost: "text-tertiary hover:bg-hover hover:text-primary",
  solid: "bg-white text-[#0d0d0d] hover:opacity-90",
  danger: "text-tertiary hover:bg-danger/15 hover:text-danger",
};

const IconButton = forwardRef(function IconButton(
  { icon: Icon, label, onClick, variant = "ghost", size = "md", disabled, tooltip = true, className = "", ...rest },
  ref
) {
  return (
    <span className="group/ib relative inline-flex">
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={`grid place-items-center rounded-lg transition-[background,color,transform,opacity] duration-150
          active:scale-95 disabled:opacity-40 disabled:pointer-events-none
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary/60
          ${SIZE[size]} ${VARIANT[variant]} ${className}`}
        {...rest}
      >
        <Icon size={size === "sm" ? 17 : 19} />
      </button>

      {tooltip && (
        <span
          role="tooltip"
          className="pointer-events-none absolute -top-9 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md
            bg-elevated px-2 py-1 text-xs text-primary opacity-0 shadow-lg ring-1 ring-line
            transition-opacity duration-150 group-hover/ib:opacity-100"
        >
          {label}
        </span>
      )}
    </span>
  );
});

export default IconButton;
