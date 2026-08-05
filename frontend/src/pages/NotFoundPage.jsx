import { Link } from 'react-router-dom';
import { Card, EmptyState } from '../components/ui.jsx';

export default function NotFoundPage() {
  return (
    <Card>
      <EmptyState
        title="Page not found"
        description="That screen does not exist, or you do not have access to it."
        action={
          <Link to="/" className="btn btn--primary">
            Back to the dashboard
          </Link>
        }
      />
    </Card>
  );
}
