import { Redirect } from 'expo-router';

/** A link to nothing in the app goes home, where the sign-in gate decides what shows. */
export default function NotFound() {
  return <Redirect href="/" />;
}
