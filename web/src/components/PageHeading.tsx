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
  return <header className="page-heading">
    <div className="page-heading-copy">
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      <div className="page-heading-description">
        <p>{description}</p>
        {descriptionActions && <div className="page-heading-description-actions">{descriptionActions}</div>}
      </div>
    </div>
    {actions && <div className="page-heading-actions">{actions}</div>}
  </header>;
}
