import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { AssemblyProduct } from '../types/assembly';

export const useAssemblyPartSpecs = (search?: string) => {
  return useQuery({
    queryKey: ['assembly-partspecs', search],
    queryFn: async () => {
      const params = search ? `?search=${encodeURIComponent(search)}` : '';
      const response = await api.get(`/parts/${params}`);
      return response.data;
    },
  });
};

export const useAssemblyProducts = (search?: string) => {
  return useQuery({
    queryKey: ['assembly-products', search],
    queryFn: async () => {
      const params = search ? `?search=${encodeURIComponent(search)}` : '';
      const response = await api.get(`/products/${params}`);
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
      const response = await api.get(`/parts/?search=${encodeURIComponent(partNo)}`);
      return response.data;
    },
    enabled: !!partNo && partNo.trim().length >= 2,
  });
};

export const useAssemblyModelSearch = (model?: string) => {
  return useQuery({
    queryKey: ['assembly-model-search', model],
    queryFn: async () => {
      const response = await api.get(`/parts/?model_code=${encodeURIComponent(model || '')}`);
      return response.data;
    },
    enabled: !!model && model.trim().length >= 2,
  });
};

// 모델 코드로 해당 모델의 Part 목록 조회 (Assembly products API 기반)
export const useAssemblyPartsByModel = (model?: string) => {
  return useQuery({
    queryKey: ['assembly-parts-by-model', model],
    queryFn: async () => {
      if (!model || model.trim().length < 1) return [] as Array<{ part_no: string; model_code: string; description: string }>;
      const response = await api.get(`/parts/?model_code=${encodeURIComponent(model || '')}`);
      const raw = response.data as Array<{ part_no: string; model: string; process_line?: string }>;
      // PartSpec 형태에 가깝게 매핑
      return raw.map((r) => ({ part_no: r.part_no, model_code: r.model, description: '' }));
    },
    enabled: !!model && model.trim().length > 0,
  });
};

// Assembly PartSpec에서 모델 코드로 직접 조회 (가장 신뢰도 높음)
export const useAssemblyPartspecsByModel = (model?: string) => {
  return useQuery({
    queryKey: ['assembly-partspecs-by-model', model],
    queryFn: async () => {
      if (!model || model.trim().length < 1) return [] as Array<{ part_no: string; model_code: string; description: string }>;
      const { data } = await api.get(`/parts/?model_code=${encodeURIComponent(model)}`);
      // API는 pagination일 수 있음 -> results 고려
      const list = (data?.results ?? data ?? []) as any[];
      return list.map((it) => ({ part_no: it.part_no, model_code: it.model_code, description: it.description || '' }));
    },
    enabled: !!model && model.trim().length > 0,
  });
};

export const useCreateAssemblyPartSpec = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (data: { part_no: string; description?: string; model_code?: string }) => {
      const response = await api.post('/parts/', data);
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
      const response = await api.post('/products/', data);
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
      const response = await api.get(`/parts/?search=${encodeURIComponent(search)}`);
      return response.data;
    },
    enabled: !!search && search.trim().length >= 2,
  });
};