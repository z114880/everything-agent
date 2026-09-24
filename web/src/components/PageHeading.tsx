import type { ReactNode } from "react";

interface PageHeadingProps {
  eyebrow: string;
  title: string;
  description: string;
  descriptionActions?: ReactNode;
  actions?: ReactNode;
}

/** 以统一的层级、间距和操作区呈现管理页面标题。 */
export function PageHeading({ eyebrow, title, description, descriptionActions, actions }: PageHeadingProps) {
  return <header className="mb-6 flex min-h-[88px] items-start justify-between gap-6 [@media(max-width:760px)]:min-h-0 [@media(max-width:760px)]:flex-col [@media(max-width:760px)]:gap-3.5">
    <div className="min-w-0">
      <div className="mb-[7px] text-caption font-[720] leading-[1.35] tracking-[.11em] text-primary uppercase">{eyebrow}</div>
      <h1 className="m-0 text-[30px] font-bold leading-[1.1] tracking-[-.035em]">{title}</h1>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="mt-[7px] text-body leading-[1.5] text-muted-foreground">{description}</p>
        {descriptionActions && <div className="mt-[7px] flex items-center">{descriptionActions}</div>}
      </div>
    </div>
    {actions && <div className="flex shrink-0 items-center self-end pb-0.5 [@media(max-width:760px)]:self-start [@media(max-width:760px)]:pb-0">{actions}</div>}
  </header>;
}
