import { redirect } from 'next/navigation';
import { currentUser, serverApi } from '@/lib/api';
import { ProductForm } from '../../product-form';

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, api, me] = await Promise.all([params, serverApi(), currentUser()]);
  if (!me.permissions.includes('products.manage')) redirect(`/loan-products/${id}`);
  const product = await api.loanProduct(id);
  return (
    <>
      <h1 className="page-title">Change {product.name}</h1>
      <p className="page-status">Changes apply to new loans. Existing loans keep the terms they were approved on.</p>
      <ProductForm product={product} />
    </>
  );
}
