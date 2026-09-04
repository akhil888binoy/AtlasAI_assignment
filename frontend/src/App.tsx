import { Routes, Route } from 'react-router';
import Reconciliation from './pages/Reconciliation';


function App() {
  return (
    <Routes>
      <Route path="/" element={<Reconciliation />} />
    </Routes>
  )
}

export default App
