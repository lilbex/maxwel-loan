import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/api';
import { ProductForm } from '../product-form';

export default async function NewProductPage() {
  const me = await currentUser();
  if (!me.permissions.includes('products.manage')) redirect('/loan-products');
  return (
    <>
      <h1 className="page-title">Add loan product</h1>
      <ProductForm />
    </>
  );
}
