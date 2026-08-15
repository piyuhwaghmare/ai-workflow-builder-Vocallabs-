import './Header.css';

export default function Header({ email, onSignOut }) {
  const initial = email ? email.trim()[0].toUpperCase() : '?';

  return (
    <header className="header">
      <div className="header-brand">
        <div className="header-mark">
          <span className="header-dot header-dot--amber" />
          <span className="header-dot header-dot--teal" />
          <span className="header-dot header-dot--green" />
        </div>
        <span className="header-title">Workflow Control</span>
      </div>

      <div className="header-profile">
        <div className="header-avatar" title={email}>{initial}</div>
        <span className="header-email">{email}</span>
        <button className="header-signout" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}