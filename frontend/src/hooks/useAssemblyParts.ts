import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { AssemblyProduct } from '../types/assembly';

export const useAssemblyPartSpecs = (search?: string) => {
  return useQuery({
    queryKey: ['assembly-partspecs', search],
    queryFn: async () => {
      const params = search ? `?search=${encodeURIComponent(search)}` : '';
      const response = await api.get(`/assembly/api/partspecs/${params}`);
      return response.data;
    },
  });
};

export const useAssemblyProducts = (search?: string) => {
  return useQuery({
    queryKey: ['assembly-products', search],
    queryFn: async () => {
      const params = search ? `?search=${encodeURIComponent(search)}` : '';
      const response = await api.get(`/assembly/api/products/${params}`);
      return response.data;
    },
  });
};

// P/N과 Model 상호 검색 기능
export const useAssemblyPartSearch = (partNo?: string) => {
  return useQuery({
    queryKey: ['assembly-part-search', partNo],
    queryFn: async () => {
      if (!partNo || partNo.trim().length < 2) return [];
      const response = await api.get(`/assembly/api/products/search-by-part/?part_no=${encodeURIComponent(partNo)}`);
      return response.data;
    },
    enabled: !!partNo && partNo.trim().length >= 2,
  });
};

export const useAssemblyModelSearch = (model?: string) => {
  return useQuery({
    queryKey: ['assembly-model-search', model],
    queryFn: async () => {
      if (!model || model.trim().length < 2) return [];
      const response = await api.get(`/assembly/api/products/search-by-model/?model=${encodeURIComponent(model)}`);
      return response.data;
    },
    enabled: !!model && model.trim().length >= 2,
  });
};

export const useCreateAssemblyPartSpec = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (data: { part_no: string; description?: string; model_code?: string }) => {
      const response = await api.post('/assembly/api/partspecs/create-or-update/', data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assembly-partspecs'] });
    },
  });
};

export const useCreateAssemblyProduct = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (data: Omit<AssemblyProduct, 'id'>) => {
      const response = await api.post('/assembly/api/products/', data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assembly-products'] });
      queryClient.invalidateQueries({ queryKey: ['assembly-part-search'] });
      queryClient.invalidateQueries({ queryKey: ['assembly-model-search'] });
    },
  });
};

// Part No. 자동완성을 위한 검색 hook
export const useAssemblyPartNoSearch = (search?: string) => {
  return useQuery({
    queryKey: ['assembly-partno-search', search],
    queryFn: async () => {
      if (!search || search.trim().length < 2) return [];
      const response = await api.get(`/assembly/api/products/search-parts/?search=${encodeURIComponent(search)}`);
      return response.data;
    },
    enabled: !!search && search.trim().length >= 2,
  });
};